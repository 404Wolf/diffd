//! Helpers for integration tests: throwaway git repos and an in-memory app.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use diffd_server::App;
use diffd_server::adapters::difft::{Difftastic, NoEngine};
use diffd_server::adapters::git::GitCli;
use diffd_server::adapters::store::Store;
use diffd_server::ports::{DiffEngine, SystemClock};

pub struct Repo {
    pub dir: tempfile::TempDir,
}

impl Default for Repo {
    fn default() -> Self {
        Self::new()
    }
}

impl Repo {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let repo = Self { dir };
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "user.email", "test@example.com"]);
        repo.git(&["config", "user.name", "Test"]);
        repo
    }

    pub fn path(&self) -> PathBuf {
        self.dir.path().canonicalize().unwrap()
    }

    pub fn git(&self, args: &[&str]) {
        let ok = Command::new("git").arg("-C").arg(self.dir.path()).args(args).status().unwrap().success();
        assert!(ok, "git {args:?} failed");
    }

    pub fn write(&self, path: &str, content: &str) {
        let p = self.dir.path().join(path);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    }

    pub fn commit(&self, msg: &str) {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", msg]);
    }
}

pub fn engine() -> Arc<dyn DiffEngine> {
    match Difftastic::detect() {
        Some(d) => Arc::new(d),
        None => Arc::new(NoEngine),
    }
}

pub async fn app() -> Arc<App> {
    let store = Store::open("sqlite::memory:").await.unwrap();
    App::new(store, Arc::new(GitCli), engine(), Arc::new(SystemClock), "http://localhost:3433".into())
}

pub fn exists(p: &Path) -> bool {
    p.exists()
}
