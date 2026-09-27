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
