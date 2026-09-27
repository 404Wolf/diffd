//! The commits a review spans, and diffs between any two of them, so the page
//! can walk a range one commit at a time.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use diffd_core::model::{History, ReviewId, ReviewMeta, Snapshot};
use diffd_core::protocol::ServerMsg;
use tokio::sync::OnceCell;

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
    ///
    /// A single step also starts diffing the steps around it in the
    /// background, so walking the commits one at a time rarely waits.
    pub async fn range(&self, id: &ReviewId, from: &str, to: RangeEnd) -> Result<Arc<Snapshot>> {
        let live = self.live(id).await?;
        let (meta, spec) = self.meta(id).await?;
        let history = self.history(&live, &meta, &spec).await;
        let points = points(&history);
        let index = |rev: &str| points.iter().position(|p| p.as_deref() == Some(rev));
        let from_at = index(from).ok_or_else(|| AppError::Invalid(format!("`{from}` isn't a commit in this review")))?;
        let to_at = match &to {
            Some(rev) => index(rev).ok_or_else(|| AppError::Invalid(format!("`{rev}` isn't a commit in this review")))?,
            None if !history.worktree => return Err(AppError::Invalid("this review doesn't include the working tree".into())),
            None => points.len() - 1,
        };
        if to_at <= from_at {
            return Err(AppError::Invalid("`to` must come after `from`".into()));
        }
        // Exactly these two points: no merge base, same paths and collapse rules.
        let spec = ReviewSpec { base: None, merge_base: Some(false), ..spec };
        let snap = self.build_range(&live, &meta.repo_path, &spec, from, to.as_deref()).await?;
        if to_at == from_at + 1 {
            self.prefetch_steps(live, meta.repo_path, spec, points, from_at);
        }
        Ok(snap)
    }

    /// One range's diff: from the cache, or built once however many ask for it at the same time.
    async fn build_range(&self, live: &Live, repo_path: &str, spec: &ReviewSpec, from: &str, to: Option<&str>) -> Result<Arc<Snapshot>> {
        let cell = live.inner.lock().expect("live lock").ranges.cell(&(from.to_owned(), to.map(str::to_owned)));
        let snap = cell
            .get_or_try_init(|| async {
                let (source, engine, spec) = (self.repo.clone(), self.engine.clone(), spec.clone());
                let (path, from, to) = (repo_path.to_owned(), from.to_owned(), to.map(str::to_owned));
                let snap = tokio::task::spawn_blocking(move || -> Result<Snapshot> {
                    let started = Instant::now();
                    let Built { inputs, files, .. } =
                        read_and_build(source.as_ref(), engine.as_ref(), Path::new(&path), &from, to.as_deref(), &spec)
                            .map_err(|e| AppError::Invalid(format!("{e:#}")))?;
                    let snap = build_snapshot(0, &inputs, files);
                    tracing::debug!(from, to, files = snap.files.len(), ms = started.elapsed().as_millis() as u64, "diffed a range");
                    Ok(snap)
                })
                .await
                .map_err(|e| anyhow::anyhow!(e))??;
                Ok::<_, AppError>(Arc::new(snap))
            })
            .await?;
        Ok(snap.clone())
    }

    /// Diff the steps around step `at` in the background, nearest first: the
    /// next one, the previous one, then the one after next. Steps are diffed
    /// one at a time across reviews, and a newer request for the same review
    /// takes over from an older one's.
    fn prefetch_steps(&self, live: Arc<Live>, repo_path: String, spec: ReviewSpec, points: Vec<RangeEnd>, at: usize) {
        let Some(app) = self.me.upgrade() else { return };
        let generation = live.inner.lock().expect("live lock").ranges.next_generation();
        let steps = [Some(at + 1), at.checked_sub(1), Some(at + 2)];
        tokio::spawn(async move {
            let _turn = app.prefetching.lock().await;
            for from_at in steps.into_iter().flatten() {
                let (Some(Some(from)), Some(to)) = (points.get(from_at), points.get(from_at + 1)) else { continue };
                {
                    let inner = live.inner.lock().expect("live lock");
                    if inner.ranges.generation() != generation {
                        return;
                    }
                    if inner.ranges.is_ready(&(from.clone(), to.clone())) {
                        continue;
                    }
                }
                if let Err(e) = app.build_range(&live, &repo_path, &spec, from, to.as_deref()).await {
                    tracing::debug!(from, to, error = %e, "couldn't diff a step ahead of time");
                }
            }
        });
    }
}

/// The points a review's history can be diffed between: the base, each
/// commit, and `None` for the working tree when the review ends there.
fn points(history: &History) -> Vec<RangeEnd> {
    let commits = history.commits.iter().map(|c| Some(c.sha.clone()));
    let mut points: Vec<RangeEnd> = std::iter::once(Some(history.base.clone())).chain(commits).collect();
    if history.worktree {
        points.push(None);
    }
    points
}

type RangeKey = (String, RangeEnd);
/// A range's diff once it's built. Everyone who asks while it's being built waits for that one build.
type RangeCell = Arc<OnceCell<Arc<Snapshot>>>;

/// The most recently used sub-range diffs. Ranges ending at the working tree
/// go stale as files change, so they're dropped whenever the review rebuilds.
#[derive(Default)]
pub(super) struct RangeCache {
    /// Least recently used first.
    entries: VecDeque<(RangeKey, RangeCell)>,
    /// Bumped by every request that diffs steps ahead of time, so older ones stop.
    generation: u64,
}

impl RangeCache {
    /// The cell for `key`, now the most recently used: a new, empty one when
    /// it isn't cached, making room by dropping the least recently used.
    fn cell(&mut self, key: &RangeKey) -> RangeCell {
        let cell = match self.entries.iter().position(|(k, _)| k == key) {
            Some(i) => self.entries.remove(i).map(|(_, c)| c).unwrap_or_default(),
            None => RangeCell::default(),
        };
        while self.entries.len() >= MAX_CACHED_RANGES {
            self.entries.pop_front();
        }
        self.entries.push_back((key.clone(), cell.clone()));
        cell
    }

    /// Whether `key`'s diff is built and cached.
    fn is_ready(&self, key: &RangeKey) -> bool {
        self.entries.iter().any(|(k, c)| k == key && c.initialized())
    }

    fn next_generation(&mut self) -> u64 {
        self.generation += 1;
        self.generation
    }

    fn generation(&self) -> u64 {
        self.generation
    }

    pub(super) fn clear_worktree(&mut self) {
        self.entries.retain(|((_, to), _)| to.is_some());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(from: &str) -> RangeKey {
        (from.to_owned(), Some("tip".to_owned()))
    }

    fn built(cache: &mut RangeCache, from: &str) {
        cache.cell(&key(from)).set(Arc::new(Snapshot { revision: 0, files: vec![], symbols: vec![] })).unwrap();
    }

    #[test]
    fn keeps_the_most_recently_used_ranges() {
        let mut cache = RangeCache::default();
        for i in 0..MAX_CACHED_RANGES {
            built(&mut cache, &i.to_string());
        }
        // Using the oldest keeps it; the next oldest makes room instead.
        assert!(cache.cell(&key("0")).initialized());
        built(&mut cache, "new");
        assert!(cache.is_ready(&key("0")) && cache.is_ready(&key("new")));
        assert!(!cache.is_ready(&key("1")));
        assert_eq!(cache.entries.len(), MAX_CACHED_RANGES);
    }

    #[test]
    fn a_range_being_built_is_not_ready() {
        let mut cache = RangeCache::default();
        let cell = cache.cell(&key("a"));
        assert!(!cache.is_ready(&key("a")));
        assert!(Arc::ptr_eq(&cell, &cache.cell(&key("a"))), "the same build is shared");
        cache.entries.push_back(((String::from("b"), None), RangeCell::default()));
        cache.clear_worktree();
        assert_eq!(cache.entries.len(), 1);
    }
}
