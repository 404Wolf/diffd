//! Opening a review.

use std::path::PathBuf;

use diffd_core::model::{ActivityKind, ReviewId, ReviewMeta, ReviewStatus};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::conversation::{NoteInput, RegionInput, regions_from};
use super::rebuild::{build_snapshot, read_and_build};
use super::{App, AppError, Result, new_id};
use crate::adapters::store::{CollapseRule, ReviewSpec};

#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ShareRequest {
    /// Absolute path of the repository or worktree (normally your working directory).
    pub repo_path: String,
    /// What to compare against: any revision git understands, e.g. `main`, `HEAD`, `v1.2.0`, `HEAD~3`.
    /// `HEAD` with no `to` shows only uncommitted changes.
    pub from: String,
    /// The other side. Omit it to compare against the working tree, including
    /// uncommitted and untracked files; the review then updates live as files change.
    #[serde(default)]
    pub to: Option<String>,
    /// Diff from the merge base of `from` and `to`, like a pull request.
    /// Defaults to true when `from` is a branch.
    #[serde(default)]
    pub merge_base: Option<bool>,
    /// Only include these paths (git pathspecs).
    #[serde(default)]
    pub paths: Vec<String>,
    /// A short title, like a PR title.
    pub title: String,
    /// Markdown: what changed and why, shown above the diff.
    #[serde(default)]
    pub summary: Option<String>,
    /// Plain-language notes on the parts a reviewer would trip over, in reading order.
    #[serde(default)]
    pub annotations: Vec<NoteInput>,
    /// Files that should start collapsed: generated code, lockfiles, snapshots, vendored code.
    #[serde(default)]
    pub collapse: Vec<CollapseRule>,
    /// Label ranges: `test` for test code (whole files or line ranges), `fold` to fold
    /// mechanical or uninteresting changes behind a one-sentence summary.
    #[serde(default)]
    pub regions: Vec<RegionInput>,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ShareResult {
    pub review_id: String,
    /// Give this link to the user.
    pub url: String,
    pub revision: u32,
    pub files: usize,
    pub added: u32,
    pub removed: u32,
    /// Paths that start collapsed.
    pub collapsed: Vec<String>,
    /// Whether the review follows the working tree as it changes.
    pub live: bool,
    pub next_step: String,
}

impl App {
    pub async fn share(&self, req: ShareRequest) -> Result<ShareResult> {
        let repo_path = PathBuf::from(&req.repo_path);
        if !repo_path.is_absolute() {
            return Err(AppError::Invalid("repo_path must be an absolute path".into()));
        }
        let spec = ReviewSpec {
            merge_base: req.merge_base,
            paths: req.paths.clone(),
            collapse: req.collapse.clone(),
            watch: req.to.is_none(),
            regions: Vec::new(),
        };
        let (source, engine, spec2) = (self.repo.clone(), self.engine.clone(), spec.clone());
        let (from, to) = (req.from.clone(), req.to.clone());
        let (repo, inputs, files, fp) =
            tokio::task::spawn_blocking(move || read_and_build(source.as_ref(), engine.as_ref(), &repo_path, &from, to.as_deref(), &spec2))
                .await
                .map_err(|e| anyhow::anyhow!(e))?
                .map_err(|e| AppError::Invalid(format!("{e:#}")))?;

        let snap = build_snapshot(1, &inputs, files);
        let mut spec = spec;
        spec.regions = regions_from(&snap, req.regions)?;
        let id = ReviewId(new_id(""));
        let now = self.now();
        let meta = ReviewMeta {
            id: id.clone(),
            title: req.title,
            summary: req.summary.filter(|s| !s.trim().is_empty()),
            repo_path: repo.root.to_string_lossy().into_owned(),
            repo_name: repo.name,
            from: req.from,
            to: req.to,
            revision: 1,
            status: ReviewStatus::Open,
            created_at: now,
            updated_at: now,
        };
        self.store.insert_review(&meta, &spec).await?;
        self.store.insert_revision(&id, &snap, now).await?;

        let result = ShareResult {
            review_id: id.0.clone(),
            url: self.url(&id),
            revision: 1,
            files: snap.files.len(),
            added: snap.files.iter().map(|f| f.added).sum(),
            removed: snap.files.iter().map(|f| f.removed).sum(),
            collapsed: snap.files.iter().filter(|f| f.collapsed.is_some()).map(|f| f.path.clone()).collect(),
            live: spec.watch,
            next_step: "Send the user the url. Then call wait_for_feedback to hear their comments; reply in threads with reply, and use say for anything not tied to lines.".into(),
        };
        let live = self.insert_live(&id, snap, fp);
        self.set_fingerprint(&live, fp);
        let notes = self.add_notes(&id, req.annotations, false).await?;
        let item = self
            .store
            .add_activity(&id, now, ActivityKind::Opened { notes: notes as u32, collapsed: result.collapsed.len() as u32 })
            .await?;
        App::broadcast(&live, diffd_core::protocol::ServerMsg::Activity { item });
        self.agent_seen(&live);
        if spec.watch {
            self.start_watch(&meta);
        }
        Ok(result)
    }
}
