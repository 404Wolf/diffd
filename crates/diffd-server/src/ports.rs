//! The server's edges. Use cases in [`crate::app`] are written against these
//! traits; adapters implement them for git, difftastic and the system clock,
//! and tests swap in fakes.

use std::path::{Path, PathBuf};

use diffd_core::build::FileInput;
use diffd_core::difft::EngineDiff;
use diffd_core::model::{CodeAnswer, CodeQuery, Commit, Diagnostic, LanguageServerStatus, Millis, ReviewId};
use futures::future::BoxFuture;
use tokio::sync::{broadcast, watch};

/// A repository the agent pointed us at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repo {
    pub root: PathBuf,
    pub name: String,
}

/// Two resolved revisions: `base` is a commit, `to` is a commit or the working tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub base: String,
    pub to: Option<String>,
}

/// Reads repositories.
pub trait RepoSource: Send + Sync {
    fn open(&self, path: &Path) -> anyhow::Result<Repo>;
    /// Resolve `from`/`to` to commits. With `merge_base`, `base` is the merge
    /// base of `from` and `to` (or `HEAD` when `to` is the working tree).
    fn resolve(&self, repo: &Repo, from: &str, to: Option<&str>, merge_base: Option<bool>) -> anyhow::Result<Resolved>;
    /// Every changed file between the two sides, with full contents.
    fn changes(&self, repo: &Repo, resolved: &Resolved, paths: &[String]) -> anyhow::Result<Vec<FileInput>>;
    /// The commits after `base` up to `to` (or `HEAD`), oldest first along
    /// first parents; at most `limit` of the newest. Also says whether more were left out.
    fn commits(&self, repo: &Repo, resolved: &Resolved, limit: usize) -> anyhow::Result<(Vec<Commit>, bool)>;
    /// Every file on the `to` side (the working tree: tracked and untracked, minus ignored), tree-ordered.
    fn files(&self, repo: &Repo, resolved: &Resolved) -> anyhow::Result<Vec<String>>;
    /// One file on the `to` side, or `None` when there's no such file (or the path leads out of the
    /// repository). Paths are repository-relative.
    fn read(&self, repo: &Repo, resolved: &Resolved, path: &str) -> anyhow::Result<Option<Contents>>;
}

/// Files larger than this are listed but never read.
pub const MAX_FILE_BYTES: u64 = 3 * 1024 * 1024;

/// A file's contents, unless it's over [`MAX_FILE_BYTES`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Contents {
    Bytes(Vec<u8>),
    TooLarge,
}

/// A structural diff engine (difftastic). Returns `None` when it can't help,
/// and the caller falls back to a line diff.
pub trait DiffEngine: Send + Sync {
    fn diff(&self, path: &str, old: &str, new: &str) -> Option<EngineDiff>;
}

pub trait Clock: Send + Sync {
    fn now(&self) -> Millis;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Millis {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as Millis).unwrap_or_default()
    }
}

/// A file's diagnostics, by absolute path (as language servers report them).
#[derive(Debug, Clone)]
pub struct FileDiagnostics {
    pub path: PathBuf,
    pub diagnostics: Vec<Diagnostic>,
}

/// A language server and the project root it runs for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerStatus {
    pub root: PathBuf,
    pub status: LanguageServerStatus,
}

/// What language servers know about files on disk. Paths are relative to `repo_root`.
pub trait CodeIntel: Send + Sync {
    /// Open a file (or tell its server it changed), so its diagnostics arrive.
    fn sync<'a>(&'a self, repo_root: &'a Path, path: &'a str) -> BoxFuture<'a, ()>;
    /// Ask about a position: line 1-based, column in UTF-16 code units.
    fn ask<'a>(&'a self, repo_root: &'a Path, path: &'a str, query: CodeQuery, line: u32, col: u32) -> BoxFuture<'a, CodeAnswer>;
    /// Diagnostics as servers publish them, for every file they have open.
    fn diagnostics(&self) -> broadcast::Receiver<FileDiagnostics>;
    /// Every server that's starting, running or couldn't start, as it changes.
    fn servers(&self) -> watch::Receiver<Vec<ServerStatus>>;
    /// Stop the servers for the repository at `repo_root`: nobody is looking at it.
    fn release<'a>(&'a self, repo_root: &'a Path) -> BoxFuture<'a, ()>;
}

/// Follows working trees, so reviews of them rebuild as files change.
pub trait TreeWatch: Send + Sync {
    /// Start following review `id`'s repository at `root`. Calling it again is harmless.
    fn watch(&self, id: &ReviewId, root: &Path);
    /// Stop following review `id` (it was deleted).
    fn unwatch(&self, id: &ReviewId);
}

/// A Herdr core's per-terminal inbox: messages an agent's harness reads out
/// of band, so nothing is ever typed into its input (herdr-core's
/// `terminal.queue`, `hc send --inbox-only`). Review feedback goes there when
/// it can (see `app::push`); the harness hooks deliver it otherwise.
pub trait AgentInbox: Send + Sync {
    /// The core on this machine, if one answers.
    fn local_core(&self) -> BoxFuture<'_, Option<InboxCore>>;
    /// Queue a notice in a terminal's inbox. Never typed into the terminal.
    fn send<'a>(&'a self, notice: &'a Outgoing) -> BoxFuture<'a, Sent>;
}

/// The local Herdr core, as an [`AgentInbox`] sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InboxCore {
    pub id: String,
    /// It takes inbox-only messages with keys (`queue-keyed`); a core that
    /// predates them doesn't.
    pub queues: bool,
    /// How long it remembers a key it queued: a send with an unclear
    /// outcome may be retried for (well) under this long.
    pub keys_kept: std::time::Duration,
}

/// One notice for one agent's inbox, the same on every attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outgoing {
    pub terminal: String,
    /// The core the terminal belongs to (its id): another core refuses, so
    /// an attempt never reaches a terminal that took over the address.
    pub core: String,
    /// Names the notice: the core queues a key once, and remembers it for
    /// [`InboxCore::keys_kept`], across restarts.
    pub key: String,
    /// When the key was first sent (ms since the epoch): a core that may
    /// have forgotten it since refuses instead of queuing it again.
    pub since_ms: Millis,
    pub text: String,
}

/// How an inbox send ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sent {
    /// The core queued it, now or under the same key before.
    Queued,
    /// The core says it never queued this key: nothing follows that inbox,
    /// or the address is bad. Safe to announce some other way.
    Refused,
    /// Not queued now, and nothing here can say whether an earlier attempt
    /// under the key was: another core, a core or hc without keys, a key the
    /// core may have forgotten, a removed terminal, or no hc at all. The
    /// hooks announce it (twice at worst, never not at all).
    Unvouched,
    /// No clear answer (a timeout, a lost connection, an unreadable reply):
    /// it may have been queued.
    Unknown,
}
