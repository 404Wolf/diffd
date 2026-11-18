//! Building snapshots from the repository, and rebuilding them as files change.

use std::collections::{HashMap, HashSet};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use diffd_core::anchor::{Reanchor, map_line, reanchor};
use diffd_core::build::{FileInput, build_file, mark_since, snapshot};
use diffd_core::kinds;
use diffd_core::model::{ActivityKind, FileDiff, FileStatus, ReviewId, Revision, Side, Snapshot, Thread};
use diffd_core::protocol::{ServerMsg, SnapshotDelta};
use globset::{Glob, GlobSetBuilder};
use rayon::prelude::*;

use super::{App, AppError, Result};
use crate::adapters::store::{CollapseRule, ReviewSpec};
use crate::config::Limits;
use crate::ports::{DiffEngine, ReadBudget, Repo, RepoSource, Resolved};

/// A review's files, read and diffed.
pub(super) struct Built {
    pub repo: Repo,
    pub resolved: Resolved,
    pub inputs: Vec<FileInput>,
    pub files: Vec<FileDiff>,
    /// Changes whenever any file's contents do.
    pub fingerprint: u64,
}

/// What a build may use: see `[limits]` in the config.
struct BuildLimits<'a> {
    limits: &'a Limits,
    pool: &'a rayon::ThreadPool,
    stopping: &'a AtomicBool,
}

/// Read the repository and build every file's diff (blocking; see [`App::build`]).
/// A path that isn't a repository, revisions that don't resolve and bad collapse
/// globs are the caller's mistake; failing to read the changes is ours.
fn read_and_build(
    repo_source: &dyn RepoSource,
    engine: &dyn DiffEngine,
    build: BuildLimits<'_>,
    repo_path: &Path,
    from: &str,
    to: Option<&str>,
    spec: &ReviewSpec,
) -> Result<Built> {
    let invalid = |e: anyhow::Error| AppError::Invalid(format!("{e:#}"));
    let limits = build.limits;
    let started = std::time::Instant::now();
    let repo = repo_source.open(repo_path).map_err(invalid)?;
    let resolved = resolve(repo_source, &repo, from, to, spec).map_err(invalid)?;
    let budget = ReadBudget { max_files: limits.review_max_files, max_bytes: limits.review_max_bytes };
    let mut inputs = repo_source.changes(&repo, &resolved, &spec.paths, budget)?;
    apply_collapse(&mut inputs, &spec.collapse).map_err(invalid)?;
    let fingerprint = fingerprint(&inputs);
    let read_ms = started.elapsed().as_millis() as u64;
    let plan = engine_plan(&inputs, limits);
    let difft = plan.iter().filter(|u| **u).count();
    let skipped = plan.iter().zip(&inputs).filter(|(use_engine, i)| !**use_engine && modified(i)).count();
    let stopping = build.stopping;
    let files = build.pool.install(|| {
        inputs
            .par_iter()
            .zip(&plan)
            .map(|(input, &use_engine)| {
                if stopping.load(Ordering::Relaxed) {
                    return Err(AppError::Internal(anyhow::anyhow!("diffd is stopping")));
                }
                let engine_diff = match (&input.old, &input.new) {
                    (Some(old), Some(new)) if use_engine => engine.diff(&input.path, old, new),
                    _ => None,
                };
                Ok(build_file(input, engine_diff))
            })
            .collect::<Result<Vec<_>>>()
    })?;
    let ms = started.elapsed().as_millis() as u64;
    tracing::debug!(repo = %repo.root.display(), files = inputs.len(), difft, line_diffs_instead = skipped, read_ms, ms, "built a review");
    Ok(Built { repo, resolved, inputs, files, fingerprint })
}

/// A file with both sides read, which difftastic could diff.
fn modified(input: &FileInput) -> bool {
    input.omitted.is_none() && input.status != FileStatus::Added && input.old.is_some() && input.new.is_some()
}

fn line_count(text: &str) -> usize {
    text.bytes().filter(|&b| b == b'\n').count() + 1
}

/// Which files go through difftastic: modified files that aren't collapsed,
/// generated (see [`kinds::line_diff_only`]) or too big, in order, until the
/// build's budget of files and bytes runs out. Everything else gets a line diff.
fn engine_plan(inputs: &[FileInput], limits: &Limits) -> Vec<bool> {
    let (mut files, mut bytes) = (0usize, 0u64);
    inputs
        .iter()
        .map(|input| {
            let (Some(old), Some(new)) = (&input.old, &input.new) else { return false };
            if !modified(input) || input.collapsed.is_some() || kinds::line_diff_only(&input.path, old, new).is_some() {
                return false;
            }
            let size = (old.len() + new.len()) as u64;
            if old.len().max(new.len()) as u64 > limits.difft_max_file_bytes
                || line_count(old).max(line_count(new)) > limits.difft_max_file_lines
                || files >= limits.difft_files_per_build
                || bytes + size > limits.difft_bytes_per_build
            {
                return false;
            }
            files += 1;
            bytes += size;
            true
        })
        .collect()
}

/// The review's two sides, using the base pinned at share time when there is one.
pub(super) fn resolve(source: &dyn RepoSource, repo: &Repo, from: &str, to: Option<&str>, spec: &ReviewSpec) -> anyhow::Result<Resolved> {
    match &spec.base {
        Some(base) => source.resolve(repo, base, to, Some(false)),
        None => source.resolve(repo, from, to, spec.merge_base),
    }
}

fn apply_collapse(inputs: &mut [FileInput], rules: &[CollapseRule]) -> anyhow::Result<()> {
    if rules.is_empty() {
        return Ok(());
    }
    let mut builder = GlobSetBuilder::new();
    for rule in rules {
        builder.add(Glob::new(&rule.glob).map_err(|e| anyhow::anyhow!("bad collapse glob `{}`: {e}", rule.glob))?);
    }
    let set = builder.build()?;
    for input in inputs {
        if let Some(&i) = set.matches(&input.path).first() {
            input.collapsed.get_or_insert_with(|| rules[i].reason.clone());
        }
    }
    Ok(())
}

fn fingerprint(inputs: &[FileInput]) -> u64 {
    let mut h = DefaultHasher::new();
    for i in inputs {
        (&i.path, &i.old_path, &i.old, &i.new, &i.collapsed, i.omitted, &i.details).hash(&mut h);
    }
    h.finish()
}

impl App {
    /// Read the repository and build every file's diff, off the async runtime.
    /// At most `limits.builds` run at once, across reviews; the rest wait their turn.
    pub(super) async fn build(&self, repo_path: &Path, from: &str, to: Option<&str>, spec: &ReviewSpec) -> Result<Built> {
        let _turn = self.builds.acquire().await.map_err(|_| AppError::Internal(anyhow::anyhow!("diffd is stopping")))?;
        let (source, engine, spec) = (self.repo.clone(), self.engine.clone(), spec.clone());
        let (limits, pool, stopping) = (self.limits.clone(), self.build_pool.clone(), self.stopping.clone());
        let (path, from, to) = (repo_path.to_owned(), from.to_owned(), to.map(str::to_owned));
        tokio::task::spawn_blocking(move || {
            let build = BuildLimits { limits: &limits, pool: &pool, stopping: &stopping };
            read_and_build(source.as_ref(), engine.as_ref(), build, &path, &from, to.as_deref(), &spec)
        })
        .await
        .map_err(anyhow::Error::from)?
    }

    /// Rebuild a review from the repository. Returns the new revision, or
    /// `None` when nothing changed.
    pub async fn rebuild(&self, id: &ReviewId) -> Result<Option<Revision>> {
        let live = self.live(id).await?;
        let _guard = live.rebuild.lock().await;
        let (mut meta, spec) = self.meta(id).await?;
        let Built { inputs, files, fingerprint: fp, .. } =
            self.build(Path::new(&meta.repo_path), &meta.from, meta.to.as_deref(), &spec).await?;

        live.inner.lock().expect("live lock").ranges.clear_worktree();
        self.refresh_history(&live, &meta, &spec).await;
        let prev = App::snapshot(&live);
        if live.inner.lock().expect("live lock").fingerprint == fp {
            return Ok(None);
        }
        let before = prev.clone();
        let started = std::time::Instant::now();
        let next = tokio::task::spawn_blocking(move || next_snapshot(&before, &inputs, files)).await.map_err(|e| anyhow::anyhow!(e))?;
        tracing::debug!(review = %id, ms = started.elapsed().as_millis() as u64, changed = next.is_some(), "compared with the last revision");
        let Some((snap, changed_paths)) = next else {
            live.inner.lock().expect("live lock").fingerprint = fp;
            return Ok(None);
        };
        let revision = snap.revision;
        let now = self.now();
        let snap = Arc::new(snap);
        self.store.insert_revision(id, snap.clone(), now).await?;
        self.store.set_revision(id, revision, now).await?;
        meta.revision = revision;
        meta.updated_at = now;

        // Follow every thread's lines into the new revision.
        let mut moved = Vec::new();
        for mut t in self.store.threads(id).await? {
            if follow(&mut t, &prev, &snap, revision) {
                self.store.update_thread(&t).await?;
                moved.push(t);
            }
        }
        let mut spec = spec;
        let regions_before = spec.regions.clone();
        for r in &mut spec.regions {
            follow_region(r, &prev, &snap);
        }
        let regions_changed = spec.regions != regions_before;
        if regions_changed {
            self.store.set_spec(id, &spec).await?;
        }
        // Pages get only the files that changed; one that can't apply that is sent everything (see `adapters::http`).
        let delta = SnapshotDelta::between(&prev, &snap);
        {
            let mut inner = live.inner.lock().expect("live lock");
            inner.snapshot = snap;
            inner.fingerprint = fp;
        }
        self.sync_code(id, &live, changed_paths.clone()).await;
        App::broadcast(&live, ServerMsg::Revision { review: meta, delta: Box::new(delta) });
        for t in moved {
            App::broadcast(&live, ServerMsg::Thread { thread: t });
        }
        if regions_changed {
            App::broadcast(&live, ServerMsg::Regions { regions: spec.regions });
        }
        let item = self.store.add_activity(id, now, ActivityKind::Revision { revision, paths: changed_paths }).await?;
        App::broadcast(&live, ServerMsg::Activity { item });
        Ok(Some(revision))
    }
}

/// The snapshot after `prev`, with lines marked that changed since it, and
/// the paths that changed; `None` when no file did.
fn next_snapshot(prev: &Snapshot, inputs: &[FileInput], mut files: Vec<FileDiff>) -> Option<(Snapshot, Vec<String>)> {
    let by_path: HashMap<&str, &FileDiff> = prev.files.iter().map(|f| (f.path.as_str(), f)).collect();
    let mut changed_paths = Vec::new();
    for f in &mut files {
        match by_path.get(f.path.as_str()) {
            Some(p) => {
                mark_since(p, f);
                if p.new != f.new || p.old != f.old {
                    changed_paths.push(f.path.clone());
                }
            }
            None => {
                f.since = f.new.as_ref().map(|n| (1..=n.lines.len() as u32).collect()).unwrap_or_default();
                changed_paths.push(f.path.clone());
            }
        }
    }
    let now: HashSet<&str> = files.iter().map(|f| f.path.as_str()).collect();
    changed_paths.extend(prev.files.iter().filter(|p| !now.contains(p.path.as_str())).map(|p| p.path.clone()));
    if changed_paths.is_empty() {
        return None;
    }
    Some((snapshot(prev.revision + 1, inputs, files), changed_paths))
}

/// Follow a region's lines into a new snapshot. Whole-file regions need nothing.
fn follow_region(r: &mut diffd_core::model::Region, prev: &Snapshot, snap: &Snapshot) {
    let Some([start, end]) = r.lines else { return };
    let lines_of = |s: &Snapshot| {
        s.files.iter().find(|f| f.path == r.path).and_then(|f| match r.side {
            Side::Old => f.old.as_ref().map(|t| t.lines.clone()),
            Side::New => f.new.as_ref().map(|t| t.lines.clone()),
        })
    };
    let Some(lines) = lines_of(snap) else { return };
    match reanchor(&r.text, start, &lines) {
        Reanchor::Same => {}
        Reanchor::Moved { start, end } => r.lines = Some([start, end]),
        Reanchor::Changed => {
            let n = lines.len() as u32;
            if n == 0 {
                return;
            }
            let new_start = lines_of(prev).map_or(start, |before| map_line(&before, &lines, start)).clamp(1, n);
            let new_end = (new_start + (end - start)).min(n);
            r.lines = Some([new_start, new_end]);
            r.text = lines[new_start as usize - 1..new_end as usize].join("\n");
        }
    }
}

/// Re-anchor one thread in a new snapshot. Returns whether it changed.
fn follow(t: &mut Thread, prev: &Snapshot, snap: &Snapshot, revision: Revision) -> bool {
    let side_of = |s: &Snapshot| {
        s.files.iter().find(|f| f.path == t.anchor.path).and_then(|f| match t.anchor.side {
            Side::Old => f.old.clone(),
            Side::New => f.new.clone(),
        })
    };
    // Threads on files outside the diff (opened for context) aren't followed here.
    let in_diff = |s: &Snapshot| s.files.iter().any(|f| f.path == t.anchor.path);
    if !in_diff(snap) && !in_diff(prev) {
        return false;
    }
    let side = side_of(snap);
    let before = side_of(prev);
    let Some(side) = side else {
        if t.outdated {
            return false;
        }
        t.outdated = true;
        t.changed_in = Some(revision);
        return true;
    };
    match reanchor(&t.anchor.text, t.anchor.start, &side.lines) {
        Reanchor::Same => false,
        Reanchor::Moved { start, end } => {
            t.anchor.start = start;
            t.anchor.end = end;
            true
        }
        Reanchor::Changed => {
            let n = side.lines.len() as u32;
            if n == 0 {
                t.outdated = true;
            } else {
                let len = t.anchor.end - t.anchor.start;
                if let Some(before) = &before {
                    t.anchor.start = map_line(&before.lines, &side.lines, t.anchor.start);
                }
                t.anchor.start = t.anchor.start.clamp(1, n);
                t.anchor.end = (t.anchor.start + len).min(n);
                t.anchor.text = side.lines[t.anchor.start as usize - 1..t.anchor.end as usize].join("\n");
            }
            t.changed_in = Some(revision);
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn modified(path: &str, old: &str, new: &str) -> FileInput {
        FileInput {
            path: path.into(),
            old_path: None,
            status: FileStatus::Modified,
            old: Some(old.into()),
            new: Some(new.into()),
            omitted: None,
            details: Vec::new(),
            collapsed: None,
        }
    }

    #[test]
    fn difftastic_gets_only_files_worth_it_and_only_so_many() {
        let limits = Limits {
            difft_max_file_bytes: 100,
            difft_max_file_lines: 5,
            difft_files_per_build: 3,
            difft_bytes_per_build: 1000,
            ..Limits::default()
        };
        let added = FileInput { status: FileStatus::Added, old: None, ..modified("new.rs", "", "fn a() {}") };
        let collapsed = FileInput { collapsed: Some("moved".into()), ..modified("c.rs", "a", "b") };
        let inputs = vec![
            modified("a.rs", "fn a() {}", "fn b() {}"),
            added,
            collapsed,
            modified("Cargo.lock", "a", "b"),
            modified("openapi.json", "{}", "{\"a\":1}"),
            modified("big.rs", "a", &"x".repeat(101)),
            modified("long.rs", "a", "1\n2\n3\n4\n5\n6\n"),
            modified("b.rs", "a", "b"),
            modified("c.rs", "a", "b"),
            // Past the build's three files.
            modified("d.rs", "a", "b"),
        ];
        let plan = engine_plan(&inputs, &limits);
        let chosen: Vec<_> = inputs.iter().zip(&plan).filter(|(_, u)| **u).map(|(i, _)| i.path.as_str()).collect();
        assert_eq!(chosen, ["a.rs", "b.rs", "c.rs"]);

        let bytes = Limits { difft_bytes_per_build: 20, ..limits };
        let plan = engine_plan(&inputs, &bytes);
        let chosen: Vec<_> = inputs.iter().zip(&plan).filter(|(_, u)| **u).map(|(i, _)| i.path.as_str()).collect();
        assert_eq!(chosen, ["a.rs", "b.rs"], "18 + 2 bytes fill the 20; c.rs would go past");
    }
}
