//! Opening a review.

use std::path::PathBuf;

use diffd_core::build::snapshot;
use diffd_core::model::{ActivityKind, Group, Label, Layout, ReviewId, ReviewMeta, ReviewStatus};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::conversation::{NoteInput, RegionInput, check_layout, regions_from};
use super::rebuild::Built;
use super::{App, AppError, Result, new_id};
use crate::adapters::store::{CollapseRule, ReviewSpec};

#[derive(Debug, Clone, Default, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ShareRequest {
    /// Absolute path of the repository or worktree (normally your working directory).
    pub repo_path: String,
    /// What to compare against: any revision git understands, e.g. `main`, `HEAD`, `v1.2.0`, `HEAD~3`.
    /// `HEAD` with no `to` shows only uncommitted changes. A range spanning several commits (e.g. your
    /// branch against `main`) lets the user walk it commit by commit as well as see the whole change.
    /// The base is fixed when you share, so committing afterwards adds commits without shrinking the review.
    pub from: String,
    /// The other side. Omit it to compare against the working tree, including
    /// uncommitted and untracked files; the review then updates live as files change.
    #[serde(default)]
    pub to: Option<String>,
    /// Diff from the merge base of `from` and `to`, like a pull request.
    /// Defaults to true when `from` is a branch name (not `HEAD`, a tag or a commit).
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
    /// A guided tour of the diff, for anything more than a few files: chapters of related changes, in the
    /// order that makes the change easiest to understand. Usually the data model or types first, then the
    /// logic that uses them, then callers, UI and config, with tests last. Each chapter has a short title
    /// ("The rate limiter", "Storing quotas") and a `summary`: one or two sentences on what changed there
    /// and why, which the user reads before its code (and in the tour's sidebar). Point at the spots that
    /// matter as `path:line` (e.g. `src/bucket.rs:42`): they become links. A file belongs to the first chapter naming it; any
    /// left over go under "Other changes" at the end. The review opens on the tour; the plain diff is a
    /// click away.
    #[serde(default)]
    pub groups: Vec<Group>,
    /// Labels the user can hide files by, e.g. `frontend` for the web client or `docs`. Tests and generated
    /// files are recognised by themselves; label any the paths don't give away (`test`, `generated`).
    #[serde(default)]
    pub labels: Vec<Label>,
    /// The agent's name, from its MCP client (not a tool argument).
    #[serde(skip)]
    #[schemars(skip)]
    pub agent: Option<String>,
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

/// Longer titles belong in the summary.
const MAX_TITLE_CHARS: usize = 200;

impl App {
    pub async fn share(&self, req: ShareRequest) -> Result<ShareResult> {
        let repo_path = PathBuf::from(&req.repo_path);
        if !repo_path.is_absolute() {
            return Err(AppError::Invalid("repo_path must be an absolute path".into()));
        }
        let title = req.title.trim();
        if title.is_empty() {
            return Err(AppError::Invalid("the review needs a title".into()));
        }
        if title.chars().count() > MAX_TITLE_CHARS {
            return Err(AppError::Invalid(format!(
                "the title is {} characters; keep it under {MAX_TITLE_CHARS}, like a PR title, and put the rest in `summary`",
                title.chars().count()
            )));
        }
        let title = title.to_owned();
        let spec = ReviewSpec {
            base: None,
            merge_base: req.merge_base,
            paths: req.paths.clone(),
            collapse: req.collapse.clone(),
            watch: req.to.is_none(),
            regions: Vec::new(),
            layout: Layout::default(),
        };
        let Built { repo, resolved, inputs, files, fingerprint: fp } = self.build(&repo_path, &req.from, req.to.as_deref(), &spec).await?;

        let snap = snapshot(1, &inputs, files);
        let mut spec = spec;
        spec.base = Some(resolved.base);
        // Check everything the agent sent before saving anything: a failed share leaves no review behind.
        spec.regions = regions_from(&snap, req.regions)?;
        let labels = check_layout(&snap, &req.groups, req.labels)?;
        spec.layout = Layout { agent: req.agent, groups: req.groups, labels };
        let notes = self.prepare_notes(&snap, req.annotations, 0)?;
        let id = ReviewId(new_id(""));
        let now = self.now();
        let meta = ReviewMeta {
            id: id.clone(),
            title,
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
            next_step: if snap.files.is_empty() {
                "The diff is empty: nothing changed between those two sides. If you meant the other direction, share again with `from` and `to` swapped; for a branch, `merge_base: false` compares directly.".into()
            } else if self.hooks_active(&repo.root) {
                "Send the user the url, and end your turn when you're done: diffd wakes you when the user comments. Then call wait_for_feedback to read the comments; reply in threads with reply, and use say for anything not tied to lines.".into()
            } else {
                "Send the user the url. Then call wait_for_feedback to hear their comments; reply in threads with reply, and use say for anything not tied to lines.".into()
            },
        };
        let live = self.insert_live(&id, snap, fp);
        let notes = self.save_notes(&id, &live, notes, false).await?;
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
