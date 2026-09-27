//! difftastic, run as a subprocess with its JSON output.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use diffd_core::difft::{EngineDiff, parse};
use diffd_core::text::split_lines;

use crate::ports::DiffEngine;

/// difftastic's search graph limit, in vertices (its default is 3,000,000).
/// A file past it gets a line diff. At the default, some ordinary files
/// (ripgrep's 351-line `default_types.rs`) take 9 s before giving up; at a
/// million the same diffs come out identical in a third of the time, and the
/// hopeless cases give up in about a second.
const GRAPH_LIMIT: &str = "1000000";

pub struct Difftastic {
    pub bin: PathBuf,
    pub timeout: Duration,
}

impl Difftastic {
    /// Find `difft` (or `$DIFFD_DIFFT`) and check that it runs.
    pub fn detect() -> Option<Self> {
        let bin = std::env::var_os("DIFFD_DIFFT").map(PathBuf::from).unwrap_or_else(|| "difft".into());
        let ok = Command::new(&bin).arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
        ok.then_some(Self { bin, timeout: Duration::from_secs(10) })
    }
}

impl DiffEngine for Difftastic {
    fn diff(&self, path: &str, old: &str, new: &str) -> Option<EngineDiff> {
        let dir = tempfile::tempdir().ok()?;
        // Keep the real file name so difftastic detects the language.
        let name = path.rsplit('/').next().filter(|n| !n.is_empty()).unwrap_or("file");
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::create_dir_all(&a).ok()?;
        std::fs::create_dir_all(&b).ok()?;
        let (a, b) = (a.join(name), b.join(name));
        std::fs::write(&a, old).ok()?;
        std::fs::write(&b, new).ok()?;

        let mut child = Command::new(&self.bin)
            .args(["--display", "json", "--color", "never", "--graph-limit", GRAPH_LIMIT])
            .arg(&a)
            .arg(&b)
            .env("DFT_UNSTABLE", "yes")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let mut stdout = child.stdout.take()?;
        let reader = std::thread::spawn(move || {
            let mut s = String::new();
            stdout.read_to_string(&mut s).map(|_| s)
        });
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() > self.timeout => {
                    let _ = child.kill();
                    let _ = child.wait();
                    tracing::warn!(path, "difftastic timed out; using a line diff");
                    return None;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(5)),
                Err(_) => return None,
            }
        }
        let json = reader.join().ok()?.ok()?;
        match parse(&json, split_lines(old).len(), split_lines(new).len()) {
            Ok(diff) => diff,
            Err(err) => {
                tracing::warn!(path, %err, "unreadable difftastic output; using a line diff");
                None
            }
        }
    }
}

/// Used when difftastic isn't installed: always falls back to the line diff.
pub struct NoEngine;

impl DiffEngine for NoEngine {
    fn diff(&self, _: &str, _: &str, _: &str) -> Option<EngineDiff> {
        None
    }
}
