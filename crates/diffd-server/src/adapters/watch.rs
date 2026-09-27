//! Rebuilding reviews of the working tree as files change.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use diffd_core::model::{ReviewId, ReviewMeta};
use notify::RecursiveMode;
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};
use tokio::runtime::Handle;

use crate::app::App;

/// Directories (inside the repository) whose churn never affects a review.
const IGNORED: &[&str] = &["/.git/objects/", "/.git/logs/", "/node_modules/", "/target/", "/.direnv/"];

/// Whether a change at `path` can matter to a review of the repository at `root`.
/// Only the part inside the repository is checked: a repository that itself
/// lives under a `target/` or `node_modules/` folder still gets its updates.
fn relevant(root: &std::path::Path, path: &std::path::Path) -> bool {
    let inside = path.strip_prefix(root).unwrap_or(path);
    let p = format!("/{}", inside.to_string_lossy());
    !IGNORED.iter().any(|dir| p.contains(dir))
}

/// Owns one debounced filesystem watcher per watched review.
#[derive(Default)]
pub struct Watcher {
    watchers: Mutex<HashMap<ReviewId, Debouncer<notify::RecommendedWatcher>>>,
}

impl Watcher {
    /// Hook this watcher into `app`, so shared reviews of the working tree follow edits.
    pub fn install(self: &Arc<Self>, app: &App, runtime: Handle) {
        let this = Arc::downgrade(self);
        app.set_watcher(move |app, meta| {
            if let Some(this) = this.upgrade() {
                this.watch(app, meta, runtime.clone());
            }
        });
    }

    fn watch(&self, app: Weak<App>, meta: &ReviewMeta, runtime: Handle) {
        let id = meta.id.clone();
        let root = PathBuf::from(&meta.repo_path);
        let review = id.clone();
        // Events come with canonical paths.
        let watched = root.canonicalize().unwrap_or_else(|_| root.clone());
        let handler = move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            if !events.iter().any(|e| relevant(&watched, &e.path)) {
                return;
            }
            let (app, review) = (app.clone(), review.clone());
            runtime.spawn(async move {
                let Some(app) = app.upgrade() else { return };
                match app.rebuild(&review).await {
                    Ok(Some(rev)) => tracing::info!(%review, rev, "review updated"),
                    Ok(None) => {}
                    Err(e) => tracing::warn!(%review, error = %e, "rebuild failed"),
                }
            });
        };
        let mut debouncer = match new_debouncer(Duration::from_millis(300), handler) {
            Ok(d) => d,
            Err(e) => return tracing::warn!(error = %e, "can't watch files; the review won't update live"),
        };
        if let Err(e) = debouncer.watcher().watch(&root, RecursiveMode::Recursive) {
            return tracing::warn!(error = %e, path = %root.display(), "can't watch the repository");
        }
        self.watchers.lock().expect("watch lock").insert(id, debouncer);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn ignores_build_output_inside_the_repository_only() {
        let root = Path::new("/home/me/target/demo");
        assert!(relevant(root, Path::new("/home/me/target/demo/src/lib.rs")), "the repo is under a target/ folder");
        assert!(!relevant(root, Path::new("/home/me/target/demo/target/debug/x")));
        assert!(!relevant(root, Path::new("/home/me/target/demo/web/node_modules/a.js")));
        assert!(!relevant(root, Path::new("/home/me/target/demo/.git/objects/ab/cd")));
        assert!(relevant(root, Path::new("/home/me/target/demo/.git/refs/heads/main")), "commits count");
    }
}
