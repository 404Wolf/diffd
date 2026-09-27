//! The server's edges. Use cases in [`crate::app`] are written against these
//! traits; adapters implement them for git, difftastic and the system clock,
//! and tests swap in fakes.

use std::path::{Path, PathBuf};

use diffd_core::build::FileInput;
use diffd_core::difft::EngineDiff;
use diffd_core::model::{Commit, Millis};

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
