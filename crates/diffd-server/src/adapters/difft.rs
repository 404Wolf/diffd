//! difftastic, run as a subprocess with its JSON output.
//!
//! Only so many run at once (see [`Slots`]), each one is killed when it takes
//! too long, and [`DiffEngine::stop`] kills the ones running and turns new
//! ones away, so a stopping server doesn't wait on them.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
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

/// How often a running difftastic is checked on (done, too slow, or stopping).
const POLL: Duration = Duration::from_millis(5);

pub struct Difftastic {
    pub bin: PathBuf,
    pub timeout: Duration,
    slots: Slots,
    stopping: AtomicBool,
}

impl Difftastic {
    /// Find `difft` (or `$DIFFD_DIFFT`) and check that it runs.
    pub fn detect() -> Option<Self> {
        let bin = std::env::var_os("DIFFD_DIFFT").map(PathBuf::from).unwrap_or_else(|| "difft".into());
        let ok = Command::new(&bin).arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
        ok.then(|| Self::new(bin, Duration::from_secs(10), 3))
    }

    pub fn new(bin: PathBuf, timeout: Duration, jobs: usize) -> Self {
        Self { bin, timeout, slots: Slots::new(jobs), stopping: AtomicBool::new(false) }
    }

    /// At most `jobs` difftastic processes at once, each given up on after `timeout`.
    pub fn with_limits(self, jobs: usize, timeout: Duration) -> Self {
        Self::new(self.bin, timeout, jobs)
    }

    /// Run difftastic on one file pair; `None` when it fails, is too slow, or diffd is stopping.
    fn run(&self, path: &str, old: &str, new: &str) -> Option<String> {
        let dir = tempfile::tempdir().ok()?;
        // Keep the real file name so difftastic detects the language.
        let name = path.rsplit('/').next().filter(|n| !n.is_empty()).unwrap_or("file");
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::create_dir_all(&a).ok()?;
        std::fs::create_dir_all(&b).ok()?;
        let (a, b) = (a.join(name), b.join(name));
        std::fs::write(&a, old).ok()?;
        std::fs::write(&b, new).ok()?;

        let _slot = self.slots.take(&self.stopping)?;
        let child = Command::new(&self.bin)
            .args(["--display", "json", "--color", "never", "--graph-limit", GRAPH_LIMIT])
            .arg(&a)
            .arg(&b)
            .env("DFT_UNSTABLE", "yes")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        // Killed and reaped however this returns.
        let mut child = KillOnDrop(child);
        let mut stdout = child.0.stdout.take()?;
        let reader = std::thread::spawn(move || {
            let mut s = String::new();
            stdout.read_to_string(&mut s).map(|_| s)
        });
        let started = Instant::now();
        loop {
            match child.0.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if self.stopping.load(Ordering::SeqCst) => return None,
                Ok(None) if started.elapsed() > self.timeout => {
                    tracing::warn!(path, "difftastic timed out; using a line diff");
                    return None;
                }
                Ok(None) => std::thread::sleep(POLL),
                Err(_) => return None,
            }
        }
        reader.join().ok()?.ok()
    }
}

impl DiffEngine for Difftastic {
    fn diff(&self, path: &str, old: &str, new: &str) -> Option<EngineDiff> {
        let json = self.run(path, old, new)?;
        match parse(&json, split_lines(old).len(), split_lines(new).len()) {
            Ok(diff) => diff,
            Err(err) => {
                tracing::warn!(path, %err, "unreadable difftastic output; using a line diff");
                None
            }
        }
    }

    fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.slots.wake_all();
    }
}

/// A child process that's killed and reaped when dropped, so a timed-out or
/// abandoned difftastic never outlives its diff.
struct KillOnDrop(Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        if let Ok(None) = self.0.try_wait() {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

/// A counting semaphore for blocking threads: how many difftastics may run at once.
struct Slots {
    free: Mutex<usize>,
    freed: Condvar,
}

impl Slots {
    fn new(n: usize) -> Self {
        Self { free: Mutex::new(n.max(1)), freed: Condvar::new() }
    }

    /// Wait for a free slot; `None` once `stopping` is set.
    fn take<'a>(&'a self, stopping: &AtomicBool) -> Option<Slot<'a>> {
        let mut free = self.free.lock().expect("slots lock");
        loop {
            if stopping.load(Ordering::SeqCst) {
                return None;
            }
            if *free > 0 {
                *free -= 1;
                return Some(Slot(self));
            }
            free = self.freed.wait(free).expect("slots lock");
        }
    }

    fn wake_all(&self) {
        let _free = self.free.lock().expect("slots lock");
        self.freed.notify_all();
    }
}

struct Slot<'a>(&'a Slots);

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        *self.0.free.lock().expect("slots lock") += 1;
        self.0.freed.notify_one();
    }
}

/// Used when difftastic isn't installed: always falls back to the line diff.
pub struct NoEngine;

impl DiffEngine for NoEngine {
    fn diff(&self, _: &str, _: &str, _: &str) -> Option<EngineDiff> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;

    /// A stand-in difftastic that records how many copies run at once, then sleeps.
    fn fake_difft(dir: &std::path::Path, sleep: &str) -> PathBuf {
        let bin = dir.join("difft");
        let script = format!(
            "#!/bin/sh\necho x >> {log}/started\nn=$(ls {log}/running.* 2>/dev/null | wc -l)\necho $n >> {log}/concurrent\ntouch {log}/running.$$\nsleep {sleep}\nrm -f {log}/running.$$\necho '{{\"language\":\"Text\",\"status\":\"unchanged\"}}'\n",
            log = dir.display()
        );
        std::fs::write(&bin, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        bin
    }

    #[test]
    fn only_so_many_run_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Arc::new(Difftastic::new(fake_difft(dir.path(), "0.2"), Duration::from_secs(10), 2));
        let done = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..6)
            .map(|i| {
                let (engine, done) = (engine.clone(), done.clone());
                std::thread::spawn(move || {
                    assert!(engine.diff(&format!("f{i}.txt"), "a\n", "b\n").is_some());
                    done.fetch_add(1, Ordering::SeqCst);
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(done.load(Ordering::SeqCst), 6);
        let most =
            std::fs::read_to_string(dir.path().join("concurrent")).unwrap().lines().map(|l| l.trim().parse::<usize>().unwrap()).max();
        assert!(most.unwrap() < 2, "at most one other was running when each started: {most:?}");
    }

    #[test]
    fn a_slow_difft_is_killed_and_stop_turns_the_rest_away() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Arc::new(Difftastic::new(fake_difft(dir.path(), "30"), Duration::from_millis(200), 1));
        let started = Instant::now();
        assert!(engine.diff("a.txt", "a\n", "b\n").is_none(), "timed out");
        assert!(started.elapsed() < Duration::from_secs(5));
        let running =
            || std::fs::read_dir(dir.path()).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("running.")).count();
        // The killed script never cleaned up after itself; clear its marker.
        for e in std::fs::read_dir(dir.path()).unwrap().flatten() {
            if e.file_name().to_string_lossy().starts_with("running.") {
                let pid: i32 = e.file_name().to_string_lossy()["running.".len()..].parse().unwrap();
                assert!(!std::path::Path::new(&format!("/proc/{pid}")).exists(), "the timed-out difft was killed");
                std::fs::remove_file(e.path()).unwrap();
            }
        }

        // One diff holds the only slot; stopping ends it and the one waiting behind it.
        let long = Difftastic::new(fake_difft(dir.path(), "30"), Duration::from_secs(60), 1);
        let long = Arc::new(long);
        let waiting: Vec<_> = (0..2)
            .map(|i| {
                let long = long.clone();
                std::thread::spawn(move || long.diff(&format!("b{i}.txt"), "a\n", "b\n"))
            })
            .collect();
        while running() == 0 {
            std::thread::sleep(Duration::from_millis(10));
        }
        let stopped = Instant::now();
        long.stop();
        for t in waiting {
            assert!(t.join().unwrap().is_none());
        }
        assert!(stopped.elapsed() < Duration::from_secs(2), "stopping is prompt: {:?}", stopped.elapsed());
        assert!(long.diff("c.txt", "a\n", "b\n").is_none(), "nothing new starts once stopping");
    }
}
