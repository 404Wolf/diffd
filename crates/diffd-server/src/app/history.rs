//! The commits a review spans, and diffs between any two of them, so the page
//! can walk a range one commit at a time.

use std::path::Path;
use std::sync::Arc;

use diffd_core::model::{History, ReviewId, ReviewMeta, Snapshot};
use diffd_core::protocol::ServerMsg;

use super::rebuild::{Built, build_snapshot, read_and_build, resolve};
use super::{App, AppError, Live, Result};
use crate::adapters::store::ReviewSpec;
use crate::ports::RepoSource;

/// Walking more commits than this one at a time isn't useful.
const MAX_COMMITS: usize = 300;
/// Sub-range diffs kept in memory per review.
const MAX_CACHED_RANGES: usize = 24;

/// Where a sub-range ends: a commit, or the working tree.
pub type RangeEnd = Option<String>;

fn load(source: &dyn RepoSource, meta: &ReviewMeta, spec: &ReviewSpec) -> anyhow::Result<History> {
    let repo = source.open(Path::new(&meta.repo_path))?;
    let resolved = resolve(source, &repo, &meta.from, meta.to.as_deref(), spec)?;
    let (commits, truncated) = source.commits(&repo, &resolved, MAX_COMMITS)?;
    // When older commits were left out, the walk starts from the first listed commit's parent.
    let base = match (truncated, commits.first()) {
        (true, Some(first)) => source.resolve(&repo, &format!("{}^", first.sha), None, Some(false))?.base,
        _ => resolved.base,
    };
    Ok(History { base, commits, worktree: meta.to.is_none(), truncated })
}

impl App {
    /// The review's commits, read from the repository (blocking work off the runtime).
    async fn read_history(&self, meta: &ReviewMeta, spec: &ReviewSpec) -> History {
        let (source, meta2, spec2) = (self.repo.clone(), meta.clone(), spec.clone());
        match tokio::task::spawn_blocking(move || load(source.as_ref(), &meta2, &spec2)).await {
            Ok(Ok(h)) => h,
            // The repository may be gone; the review still opens, just without its commits.
            Ok(Err(e)) => {
                tracing::debug!(review = %meta.id, error = %e, "can't list commits");
                History { worktree: meta.to.is_none(), ..History::default() }
            }
            Err(e) => {
                tracing::warn!(error = %e, "listing commits panicked");
                History { worktree: meta.to.is_none(), ..History::default() }
            }
        }
    }

    /// The review's commits, from memory when they've been read already.
    pub(super) async fn history(&self, live: &Live, meta: &ReviewMeta, spec: &ReviewSpec) -> History {
        if let Some(h) = live.inner.lock().expect("live lock").history.clone() {
            return h;
        }
        let h = self.read_history(meta, spec).await;
        live.inner.lock().expect("live lock").history = Some(h.clone());
        h
    }

    /// Re-read the commits and tell pages when they changed (e.g. the agent committed).
    pub(super) async fn refresh_history(&self, live: &Live, meta: &ReviewMeta, spec: &ReviewSpec) {
        let h = self.read_history(meta, spec).await;
        let changed = {
            let mut inner = live.inner.lock().expect("live lock");
            let changed = inner.history.as_ref() != Some(&h);
            if changed {
                inner.history = Some(h.clone());
                inner.ranges.clear_worktree();
            }
            changed
        };
        if changed {
            App::broadcast(live, ServerMsg::History { history: h });
        }
    }

    /// The diff from `from` to `to` (a commit, or the working tree when `None`),
    /// both of which must be points in the review's history.
    pub async fn range(&self, id: &ReviewId, from: &str, to: RangeEnd) -> Result<Arc<Snapshot>> {
        let live = self.live(id).await?;
        let (meta, spec) = self.meta(id).await?;
        let history = self.history(&live, &meta, &spec).await;
        let points: Vec<&str> = std::iter::once(history.base.as_str()).chain(history.commits.iter().map(|c| c.sha.as_str())).collect();
        let index = |rev: &str| points.iter().position(|p| *p == rev);
        let from_at = index(from).ok_or_else(|| AppError::Invalid(format!("`{from}` isn't a commit in this review")))?;
        match &to {
            Some(rev) => {
                let to_at = index(rev).ok_or_else(|| AppError::Invalid(format!("`{rev}` isn't a commit in this review")))?;
                if to_at <= from_at {
                    return Err(AppError::Invalid("`to` must come after `from`".into()));
                }
            }
            None if !history.worktree => return Err(AppError::Invalid("this review doesn't include the working tree".into())),
            None => {}
        }
        let key = (from.to_owned(), to.clone());
        if let Some(snap) = live.inner.lock().expect("live lock").ranges.get(&key) {
            return Ok(snap);
        }

        let (source, engine) = (self.repo.clone(), self.engine.clone());
        let (path, from2, to2) = (meta.repo_path.clone(), from.to_owned(), to.clone());
        // Exactly these two points: no merge base, same paths and collapse rules.
        let spec2 = ReviewSpec { base: None, merge_base: Some(false), ..spec };
        let Built { inputs, files, .. } = tokio::task::spawn_blocking(move || {
            read_and_build(source.as_ref(), engine.as_ref(), Path::new(&path), &from2, to2.as_deref(), &spec2)
        })
        .await
        .map_err(|e| anyhow::anyhow!(e))?
        .map_err(|e| AppError::Invalid(format!("{e:#}")))?;
        let snap = Arc::new(build_snapshot(0, &inputs, files));
        live.inner.lock().expect("live lock").ranges.put(key, snap.clone());
        Ok(snap)
    }
}

/// A small cache of sub-range diffs. Ranges ending at the working tree go
/// stale as files change, so they're dropped whenever the review rebuilds.
#[derive(Default)]
pub(super) struct RangeCache {
    entries: Vec<((String, RangeEnd), Arc<Snapshot>)>,
}

impl RangeCache {
    fn get(&self, key: &(String, RangeEnd)) -> Option<Arc<Snapshot>> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, s)| s.clone())
    }

    fn put(&mut self, key: (String, RangeEnd), snap: Arc<Snapshot>) {
        self.entries.retain(|(k, _)| *k != key);
        if self.entries.len() >= MAX_CACHED_RANGES {
            self.entries.remove(0);
        }
        self.entries.push((key, snap));
    }

    pub(super) fn clear_worktree(&mut self) {
        self.entries.retain(|((_, to), _)| to.is_some());
    }
}
