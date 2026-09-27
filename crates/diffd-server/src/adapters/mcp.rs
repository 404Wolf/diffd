//! The MCP server agents talk to, over Streamable HTTP at `/mcp`.
//!
//! Tool descriptions are the agent's manual, so they say when and how to use
//! each tool, not just what it does.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use diffd_core::model::{Author, ReviewId, ShowRequest, Side, ThreadId, ThreadKind};
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::{ErrorData, ServerHandler, tool, tool_handler, tool_router};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::app::{App, AppError, NoteInput, RegionInput, ShareRequest};

const INSTRUCTIONS: &str = "\
diffd shows your code changes to the user as a live review in their browser, and lets you talk about them there.

When you've made a meaningful change, or the user asks to review something, call share_diff and give the user the url.
Annotate the parts a reviewer would trip over, in plain language. Mark generated files, lockfiles and vendored code to collapse.
When your work spans several commits, share the whole range (e.g. from `main`): the user can step through it one commit at a
time. Write commit messages a reviewer can follow. Comments made on one commit tell you which (`commented_on`).

Then call wait_for_feedback to hear the user's comments. Each comment is anchored to lines of code. Answer each one with reply,
in its thread, and keep it short; if you change code, the review updates by itself, so say what you changed. Messages from the
chat box arrive too: answer those with say. If the user asks you (in the terminal) where something is, call show.
Keep calling wait_for_feedback while you're in a review conversation.";

#[derive(Clone)]
pub struct DiffdMcp {
    app: Arc<App>,
    /// The review this session shared last; the default for other tools.
    last: Arc<Mutex<Option<ReviewId>>>,
}

impl DiffdMcp {
    pub fn new(app: Arc<App>) -> Self {
        Self { app, last: Arc::new(Mutex::new(None)) }
    }

    fn review(&self, id: Option<String>) -> Result<ReviewId, String> {
        id.map(ReviewId)
            .or_else(|| self.last.lock().expect("mcp lock").clone())
            .ok_or_else(|| "No review yet: call share_diff first, or pass review_id.".to_owned())
    }

    fn remember(&self, id: &ReviewId) {
        *self.last.lock().expect("mcp lock") = Some(id.clone());
    }
}

fn ok<T: Serialize>(value: &T) -> Result<CallToolResult, ErrorData> {
    let text = serde_json::to_string_pretty(value).map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}

/// Tool failures go back to the model as readable errors, not protocol errors.
fn fail(msg: impl Into<String>) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::error(vec![ContentBlock::text(msg.into())]))
}

fn app_err(e: AppError) -> Result<CallToolResult, ErrorData> {
    match e {
        AppError::Internal(e) => {
            tracing::error!(error = %format!("{e:#}"), "tool failed");
            fail(format!("diffd hit an internal error: {e:#}"))
        }
        other => fail(other.to_string()),
    }
}

macro_rules! try_app {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(e) => return app_err(e),
        }
    };
}

macro_rules! try_review {
    ($self:ident, $id:expr) => {
        match $self.review($id) {
            Ok(v) => v,
            Err(e) => return fail(e),
        }
    };
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WaitParams {
    /// Defaults to the review you shared last.
    #[serde(default)]
    pub review_id: Option<String>,
    /// Give up after this many seconds and return no items (default 240, at most 3600).
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReplyParams {
    pub thread_id: String,
    /// Markdown. Short and specific; say what you changed if you changed code.
    pub body: String,
    /// Also resolve (true) or reopen (false) the thread.
    #[serde(default)]
    pub resolve: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AnnotateParams {
    #[serde(default)]
    pub review_id: Option<String>,
    #[serde(default)]
    pub annotations: Vec<NoteInput>,
    /// Test and fold regions, as in share_diff.
    #[serde(default)]
    pub regions: Vec<RegionInput>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SayParams {
    #[serde(default)]
    pub review_id: Option<String>,
    /// Markdown. Refer to code as `path:line`; the page turns those into links.
    pub body: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ShowParams {
    #[serde(default)]
    pub review_id: Option<String>,
    /// Path of a file in the diff.
    pub file: String,
    /// First and last line, 1-based.
    pub lines: [u32; 2],
    /// Which version the lines refer to (default: new).
    #[serde(default)]
    pub side: Option<Side>,
    /// One short line shown with the prompt, e.g. "where the timeout gets clamped".
    pub message: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewParams {
    #[serde(default)]
    pub review_id: Option<String>,
}

#[derive(Serialize)]
struct ReviewOverview {
    review_id: String,
    url: String,
    title: String,
    revision: u32,
    files: Vec<FileOverview>,
    threads: Vec<ThreadOverview>,
    pending_feedback: usize,
}

#[derive(Serialize)]
struct FileOverview {
    path: String,
    added: u32,
    removed: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    collapsed: Option<String>,
}

#[derive(Serialize)]
struct ThreadOverview {
    thread_id: String,
    kind: &'static str,
    path: String,
    lines: [u32; 2],
    resolved: bool,
    outdated: bool,
    messages: Vec<String>,
}

#[tool_router]
impl DiffdMcp {
    #[tool(description = "Open a live review of your changes in the user's browser and get a link to give them. \
Compare any two revisions: `from` is a branch, tag or commit; leave out `to` to compare against the working tree \
(uncommitted and untracked files included), and the review then updates by itself as files change. For a branch, \
`from: \"main\"` shows everything since the branch point, like a pull request. \
Annotate what a reviewer would trip over: non-obvious logic, the reason behind a design choice, risky spots, anything \
you're unsure about. Skip the obvious. 1-4 plain sentences each, tight line ranges, ordered as a tour. \
Collapse generated code, lockfiles, snapshots and vendored files with `collapse` so the user doesn't scroll past them. \
Use `regions` to mark test code (`kind: \"test\"`, whole files or line ranges; the page shows a line along them) and to \
fold mechanical changes such as renames, moved code or reformatting (`kind: \"fold\"`, with a one-sentence `summary` \
of what changed there), so the user reads the interesting parts first.")]
    async fn share_diff(&self, Parameters(req): Parameters<ShareRequest>) -> Result<CallToolResult, ErrorData> {
        let result = try_app!(self.app.share(req).await);
        self.remember(&ReviewId(result.review_id.clone()));
        ok(&result)
    }

    #[tool(description = "Wait for the user's comments on the review, and return them. Returns as soon as the user has \
commented and paused (so several comments arrive together), or with no items when the timeout passes. Each item \
carries the code it's about, some context and the thread so far. Call it again after answering, for as long as you're \
reviewing together.")]
    async fn wait_for_feedback(&self, Parameters(p): Parameters<WaitParams>) -> Result<CallToolResult, ErrorData> {
        let id = try_review!(self, p.review_id);
        let timeout = Duration::from_secs(p.timeout_seconds.unwrap_or(240).clamp(1, 3600));
        let batch = try_app!(self.app.wait_for_feedback(&id, timeout).await);
        ok(&batch)
    }

    #[tool(description = "Reply in a thread on the review, where the code is. Use it to answer the user's comments. \
Keep it short; if you changed code because of the comment, say what you changed. Set `resolve` when the thread is done.")]
    async fn reply(&self, Parameters(p): Parameters<ReplyParams>) -> Result<CallToolResult, ErrorData> {
        let thread = try_app!(self.app.reply(&ThreadId(p.thread_id), None, Author::Agent, &p.body, p.resolve).await);
        ok(&serde_json::json!({ "thread_id": thread.id.0, "resolved": thread.resolved, "messages": thread.messages.len() }))
    }

    #[tool(description = "Add notes to the review, anchored to lines: explanations of tricky code, the reason for a \
decision, risks, or questions for the user. Same rules as share_diff's annotations. Can also add test and fold `regions`.")]
    async fn annotate(&self, Parameters(p): Parameters<AnnotateParams>) -> Result<CallToolResult, ErrorData> {
        let id = try_review!(self, p.review_id);
        let n = try_app!(self.app.add_notes(&id, p.annotations, true).await);
        let r = if p.regions.is_empty() { 0 } else { try_app!(self.app.add_regions(&id, p.regions).await) };
        ok(&serde_json::json!({ "notes_added": n, "regions_added": r }))
    }

    #[tool(description = "Write in the review's chat box, for anything not tied to specific lines: answering the \
user's chat messages, or telling them what you're doing. Refer to code as `path:line`.")]
    async fn say(&self, Parameters(p): Parameters<SayParams>) -> Result<CallToolResult, ErrorData> {
        let id = try_review!(self, p.review_id);
        let msg = try_app!(self.app.say(&id, &p.body).await);
        ok(&serde_json::json!({ "message_id": msg.id.0 }))
    }

    #[tool(description = "Point the user at some code in the review. The page shows a small prompt \
(\"Claude wants to show you something\") and jumps there only if they accept. Use it when the user asks where \
something is.")]
    async fn show(&self, Parameters(p): Parameters<ShowParams>) -> Result<CallToolResult, ErrorData> {
        let id = try_review!(self, p.review_id);
        let request =
            ShowRequest { path: p.file, side: p.side.unwrap_or(Side::New), start: p.lines[0], end: p.lines[1], message: p.message };
        try_app!(self.app.show(&id, request).await);
        ok(&serde_json::json!({ "shown": true }))
    }

    #[tool(description = "Rebuild the review now. Reviews of the working tree already update as files change; use this \
for a review that compares fixed revisions, or to be sure your latest edit is in.")]
    async fn refresh(&self, Parameters(p): Parameters<ReviewParams>) -> Result<CallToolResult, ErrorData> {
        let id = try_review!(self, p.review_id);
        let rev = try_app!(self.app.rebuild(&id).await);
        ok(&serde_json::json!({ "changed": rev.is_some(), "revision": rev }))
    }

    #[tool(description = "Get the review's current state: files, every thread with its messages, and how much feedback \
is waiting. Use it to catch up after losing context.")]
    async fn get_review(&self, Parameters(p): Parameters<ReviewParams>) -> Result<CallToolResult, ErrorData> {
        let id = try_review!(self, p.review_id);
        let state = try_app!(self.app.state(&id).await);
        let pending = try_app!(self.app.pending_count(&id).await);
        self.remember(&id);
        let overview = ReviewOverview {
            review_id: id.0.clone(),
            url: self.app.url(&id),
            title: state.review.title,
            revision: state.review.revision,
            files: state
                .snapshot
                .files
                .iter()
                .map(|f| FileOverview { path: f.path.clone(), added: f.added, removed: f.removed, collapsed: f.collapsed.clone() })
                .collect(),
            threads: state
                .threads
                .iter()
                .map(|t| ThreadOverview {
                    thread_id: t.id.0.clone(),
                    kind: match t.kind {
                        ThreadKind::Comment => "comment",
                        ThreadKind::Note { .. } => "your note",
                    },
                    path: t.anchor.path.clone(),
                    lines: [t.anchor.start, t.anchor.end],
                    resolved: t.resolved,
                    outdated: t.outdated,
                    messages: t
                        .messages
                        .iter()
                        .map(|m| format!("{}: {}", if m.author == Author::User { "user" } else { "you" }, m.body))
                        .collect(),
                })
                .collect(),
            pending_feedback: pending,
        };
        ok(&overview)
    }
}

#[tool_handler]
impl ServerHandler for DiffdMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("diffd", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }
}
