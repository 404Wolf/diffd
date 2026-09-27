//! Rebuilding reviews of the working tree as files change.
//!
//! One watcher per repository, shared by all its reviews. Directories whose
//! churn never matters (build output, dependencies, git's object store, and
//! whatever the repository ignores) aren't watched at all, which keeps big
//! repositories within the system's limit on watches. Only writes count:
//! reading a file (as a rebuild does) must not trigger another rebuild.
//! Changes are debounced, and a burst of them while a review is rebuilding
//! leads to one more rebuild, not one per change.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use diffd_core::model::ReviewId;
use notify::event::{MetadataKind, ModifyKind};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher as _};
use tokio::runtime::Handle;

use crate::app::App;
use crate::ports::TreeWatch;

/// How long to wait for more changes before rebuilding.
const DEBOUNCE: Duration = Duration::from_millis(300);

/// Directory names whose contents never affect a review.
const SKIPPED_DIRS: &[&str] = &["node_modules", "target", ".direnv", ".venv", "__pycache__"];
/// Inside `.git`, only what moves `HEAD`, branches or the index matters.
const GIT_SKIPPED: &[&str] = &["objects", "logs", "lfs", "modules", "hooks"];

/// Whether a change at `path` can matter to a review of the repository at `root`.
/// Only the part inside the repository is checked: a repository that itself
/// lives under a `target/` or `node_modules/` folder still gets its updates.
fn relevant(root: &Path, path: &Path) -> bool {
    let Ok(inside) = path.strip_prefix(root) else { return true };
    let parts: Vec<_> = inside.components().map(|c| c.as_os_str().to_string_lossy()).collect();
    match parts.as_slice() {
        [git, rest @ ..] if git == ".git" => !rest.first().is_some_and(|p| GIT_SKIPPED.contains(&p.as_ref())),
        parts => !parts.iter().any(|p| SKIPPED_DIRS.contains(&p.as_ref())),
    }
}

/// Watches working trees for an [`App`]. See the module docs.
pub struct Watcher {
    app: Weak<App>,
    runtime: Handle,
    /// By canonical repository root.
    repos: Mutex<HashMap<PathBuf, RepoWatch>>,
    rebuilds: Mutex<Rebuilds>,
    /// Work for the watcher's own thread: setting up a watch walks the
    /// repository, which mustn't hold up async code, and changes can't be
    /// handled on notify's thread (adding a watch from there deadlocks).
    work: std::sync::mpsc::Sender<Work>,
    me: Weak<Watcher>,
}

struct RepoWatch {
    watcher: RecommendedWatcher,
    reviews: HashSet<ReviewId>,
    /// Directories being watched (each one non-recursively).
    dirs: HashSet<PathBuf>,
    /// Directories the repository ignores, found when watching started.
    ignored: HashSet<PathBuf>,
}

enum Work {
    Watch { id: ReviewId, root: PathBuf },
    Unwatch { id: ReviewId },
    Changed { root: PathBuf, paths: Vec<PathBuf> },
}

#[derive(Default)]
struct Rebuilds {
    running: HashSet<ReviewId>,
    /// Reviews that changed again while rebuilding: they go once more.
    again: HashSet<ReviewId>,
}

impl Watcher {
    /// Watch working trees for `app`, so reviews of them follow edits.
    pub fn install(app: &Arc<App>, runtime: Handle) -> Arc<Self> {
        let (work, rx) = std::sync::mpsc::channel::<Work>();
        let watcher = Arc::new_cyclic(|me| Self {
            app: Arc::downgrade(app),
            runtime,
            repos: Mutex::new(HashMap::new()),
            rebuilds: Mutex::new(Rebuilds::default()),
            work,
            me: me.clone(),
        });
        let me = Arc::downgrade(&watcher);
        // Ends when the watcher (which holds every sender) is dropped.
        std::thread::Builder::new()
            .name("diffd-watch".into())
            .spawn(move || {
                while let Ok(work) = rx.recv() {
                    let Some(me) = me.upgrade() else { return };
                    match work {
                        Work::Watch { id, root } => me.add(id, root),
                        Work::Unwatch { id } => me.remove(&id),
                        Work::Changed { root, paths } => me.changed(&root, &paths),
                    }
                }
            })
            .expect("starting the file watcher thread");
        app.set_watcher(watcher.clone());
        watcher
    }

    fn start(&self, root: &Path) -> Option<RepoWatch> {
        let (work, watched) = (self.work.clone(), root.to_owned());
        let handler = move |res: notify::Result<Event>| {
            if let Ok(event) = res
                && writes(&event.kind)
            {
                let _ = work.send(Work::Changed { root: watched.clone(), paths: event.paths });
            }
        };
        let watcher = match notify::recommended_watcher(handler) {
            Ok(w) => w,
            Err(e) => {
                tracing::warn!(error = %e, "can't watch files; reviews won't update live");
                return None;
            }
        };
        let mut repo = RepoWatch { watcher, reviews: HashSet::new(), dirs: HashSet::new(), ignored: ignored_dirs(root) };
        repo.add_tree(root, root);
        if repo.dirs.is_empty() {
            tracing::warn!(path = %root.display(), "can't watch the repository; its reviews won't update live");
            return None;
        }
        Some(repo)
    }

    /// Follow review `id`'s repository, starting a watcher for it if needed.
    fn add(&self, id: ReviewId, root: PathBuf) {
        // Events come with canonical paths.
        let root = root.canonicalize().unwrap_or(root);
        let mut repos = self.repos.lock().expect("watch lock");
        let Some(repo) = repos.get_mut(&root) else {
            let Some(mut repo) = self.start(&root) else { return };
            repo.reviews.insert(id.clone());
            repos.insert(root, repo);
            drop(repos);
            // Catch up on anything that changed before the watch was in place
            // (while setting it up, or while diffd wasn't running).
            self.rebuild(id);
            return;
        };
        repo.reviews.insert(id);
    }

    fn remove(&self, id: &ReviewId) {
        let mut repos = self.repos.lock().expect("watch lock");
        for repo in repos.values_mut() {
            repo.reviews.remove(id);
        }
        // The last review of a repository gone: stop watching it.
        repos.retain(|_, repo| !repo.reviews.is_empty());
    }

    /// Files changed under `root`: watch new directories, rebuild its reviews.
    fn changed(&self, root: &Path, paths: &[PathBuf]) {
        let reviews = {
            let mut repos = self.repos.lock().expect("watch lock");
            let Some(repo) = repos.get_mut(root) else { return };
            let mut any = false;
            for path in paths.iter().filter(|p| relevant(root, p)) {
                any = true;
                if path.is_dir() && !repo.dirs.contains(path) {
                    repo.add_tree(root, path);
                }
            }
            if !any {
                return;
            }
            repo.reviews.iter().cloned().collect::<Vec<_>>()
        };
        for id in reviews {
            self.rebuild(id);
        }
    }

    /// Rebuild a review once changes settle, or once more after the rebuild
    /// already on its way.
    fn rebuild(&self, id: ReviewId) {
        {
            let mut r = self.rebuilds.lock().expect("rebuild lock");
            if r.running.contains(&id) {
                r.again.insert(id);
                return;
            }
            r.running.insert(id.clone());
        }
        let (app, me) = (self.app.clone(), self.me.clone());
        self.runtime.spawn(async move {
            loop {
                tokio::time::sleep(DEBOUNCE).await;
                // Whatever changed while waiting, this rebuild covers.
                if let Some(me) = me.upgrade() {
                    me.rebuilds.lock().expect("rebuild lock").again.remove(&id);
                }
                let Some(app) = app.upgrade() else { return };
                match app.rebuild(&id).await {
                    Ok(Some(rev)) => tracing::info!(review = %id, rev, "review updated"),
                    Ok(None) => {}
                    Err(e) => tracing::warn!(review = %id, error = %e, "rebuild failed"),
                }
                let Some(me) = me.upgrade() else { return };
                let mut r = me.rebuilds.lock().expect("rebuild lock");
                if !r.again.remove(&id) {
                    r.running.remove(&id);
                    return;
                }
            }
        });
    }
}

impl TreeWatch for Watcher {
    fn watch(&self, id: &ReviewId, root: &Path) {
        let _ = self.work.send(Work::Watch { id: id.clone(), root: root.to_owned() });
    }

    fn unwatch(&self, id: &ReviewId) {
        // Queued like `watch`, so it can't overtake a watch still being set up.
        let _ = self.work.send(Work::Unwatch { id: id.clone() });
    }
}

impl RepoWatch {
    /// Watch `dir` and every directory below it that can matter.
    fn add_tree(&mut self, root: &Path, dir: &Path) {
        let mut stack = vec![dir.to_owned()];
        while let Some(dir) = stack.pop() {
            if !relevant(root, &dir) || self.ignored.contains(&dir) || !self.dirs.insert(dir.clone()) {
                continue;
            }
            if let Err(e) = self.watcher.watch(&dir, RecursiveMode::NonRecursive) {
                tracing::debug!(error = %e, path = %dir.display(), "can't watch a directory");
                self.dirs.remove(&dir);
                continue;
            }
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            // Symlinked directories aren't followed: they can point anywhere.
            stack.extend(entries.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()));
        }
    }
}

/// Whether an event is a change to the files, not someone reading them.
fn writes(kind: &EventKind) -> bool {
    !matches!(kind, EventKind::Access(_) | EventKind::Modify(ModifyKind::Metadata(MetadataKind::AccessTime)))
}

/// Directories the repository ignores (`.gitignore` and friends), as absolute paths.
fn ignored_dirs(root: &Path) -> HashSet<PathBuf> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"])
        .output();
    let Some(out) = out.ok().filter(|o| o.status.success()) else { return HashSet::new() };
    String::from_utf8_lossy(&out.stdout).split('\0').filter_map(|p| p.strip_suffix('/')).map(|p| root.join(p)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_build_output_inside_the_repository_only() {
        let root = Path::new("/home/me/target/demo");
        assert!(relevant(root, Path::new("/home/me/target/demo/src/lib.rs")), "the repo is under a target/ folder");
        assert!(!relevant(root, Path::new("/home/me/target/demo/target/debug/x")));
        assert!(!relevant(root, Path::new("/home/me/target/demo/web/node_modules/a.js")));
        assert!(!relevant(root, Path::new("/home/me/target/demo/.git/objects/ab/cd")));
        assert!(relevant(root, Path::new("/home/me/target/demo/.git/refs/heads/main")), "commits count");
        assert!(relevant(root, Path::new("/home/me/target/demo/.git/index")), "staging counts");
        assert!(relevant(root, Path::new("/home/me/target/demo/src/targets.rs")), "only whole names match");
    }

    #[test]
    fn reading_files_is_not_a_change() {
        use notify::event::{AccessKind, AccessMode, CreateKind, DataChange};
        assert!(!writes(&EventKind::Access(AccessKind::Open(AccessMode::Read))));
        assert!(!writes(&EventKind::Access(AccessKind::Close(AccessMode::Read))));
        assert!(writes(&EventKind::Modify(ModifyKind::Data(DataChange::Any))));
        assert!(writes(&EventKind::Create(CreateKind::File)));
    }
}
