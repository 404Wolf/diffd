//! Building snapshots from the repository, and rebuilding them as files change.

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;
use std::sync::Arc;

use diffd_core::anchor::{Reanchor, map_line, reanchor};
use diffd_core::build::{FileInput, build_file, mark_since, snapshot};
use diffd_core::model::{ActivityKind, FileDiff, FileStatus, ReviewId, Revision, Side, Snapshot, Thread};
use diffd_core::protocol::ServerMsg;
use globset::{Glob, GlobSetBuilder};
use rayon::prelude::*;

use super::{App, AppError, Result};
use crate::adapters::store::{CollapseRule, ReviewSpec};
use crate::ports::{DiffEngine, Repo, RepoSource};

/// Read the repository and build every file's diff (blocking; run off the async runtime).
pub(super) fn read_and_build(
    repo_source: &dyn RepoSource,
    engine: &dyn DiffEngine,
    repo_path: &Path,
    from: &str,
    to: Option<&str>,
    spec: &ReviewSpec,
) -> anyhow::Result<(Repo, Vec<FileInput>, Vec<FileDiff>, u64)> {
    let repo = repo_source.open(repo_path)?;
    let resolved = repo_source.resolve(&repo, from, to, spec.merge_base)?;
    let mut inputs = repo_source.changes(&repo, &resolved, &spec.paths)?;
    apply_collapse(&mut inputs, &spec.collapse)?;
    let fingerprint = fingerprint(&inputs);
    let files = inputs
        .par_iter()
        .map(|input| {
            let engine_diff = match (&input.old, &input.new) {
                (Some(old), Some(new)) if !input.binary && input.status != FileStatus::Added => {
                    engine.diff(&input.path, old, new)
                }
                _ => None,
            };
            build_file(input, engine_diff)
        })
        .collect();
    Ok((repo, inputs, files, fingerprint))
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
        (&i.path, &i.old_path, &i.old, &i.new, &i.collapsed, i.binary).hash(&mut h);
    }
    h.finish()
}

pub(super) fn build_snapshot(revision: Revision, inputs: &[FileInput], files: Vec<FileDiff>) -> Snapshot {
    snapshot(revision, inputs, files)
}

impl App {
    /// Rebuild a review from the repository. Returns the new revision, or
    /// `None` when nothing changed.
    pub async fn rebuild(&self, id: &ReviewId) -> Result<Option<Revision>> {
        let live = self.live(id).await?;
        let _guard = live.rebuild.lock().await;
        let (mut meta, spec) = self.meta(id).await?;
        let (repo, engine) = (self.repo.clone(), self.engine.clone());
        let (path, from, to, spec2) = (meta.repo_path.clone(), meta.from.clone(), meta.to.clone(), spec.clone());
        let (_, inputs, mut files, fp) = tokio::task::spawn_blocking(move || {
            read_and_build(repo.as_ref(), engine.as_ref(), Path::new(&path), &from, to.as_deref(), &spec2)
        })
        .await
        .map_err(|e| anyhow::anyhow!(e))?
        .map_err(|e| AppError::Invalid(format!("{e:#}")))?;

        let prev = App::snapshot(&live);
        if live.inner.lock().expect("live lock").fingerprint == fp {
            return Ok(None);
        }
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
        for p in &prev.files {
            if !files.iter().any(|f| f.path == p.path) {
                changed_paths.push(p.path.clone());
            }
        }
        if changed_paths.is_empty() {
            live.inner.lock().expect("live lock").fingerprint = fp;
            return Ok(None);
        }

        let revision = prev.revision + 1;
        let snap = build_snapshot(revision, &inputs, files);
        let now = self.now();
        self.store.insert_revision(id, &snap, now).await?;
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
        {
            let mut inner = live.inner.lock().expect("live lock");
            inner.snapshot = Arc::new(snap.clone());
            inner.fingerprint = fp;
        }
        App::broadcast(&live, ServerMsg::Revision { review: meta, snapshot: Box::new(snap) });
        for t in moved {
            App::broadcast(&live, ServerMsg::Thread { thread: t });
        }
        let item = self.store.add_activity(id, now, ActivityKind::Revision { revision, paths: changed_paths }).await?;
        App::broadcast(&live, ServerMsg::Activity { item });
        Ok(Some(revision))
    }

    /// Set the fingerprint of a freshly shared review so the first watch
    /// event doesn't count as a change.
    pub(super) fn set_fingerprint(&self, live: &super::Live, fp: u64) {
        live.inner.lock().expect("live lock").fingerprint = fp;
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
