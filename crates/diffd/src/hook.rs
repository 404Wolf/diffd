//! `diffd hook …`: wake an agent that isn't listening when the user leaves
//! feedback on its review.
//!
//! An interactive agent (Claude Code, Codex) ends its turn and waits for its
//! user, so it can't be inside `wait_for_feedback` when a comment arrives.
//! These commands run as the harness's hooks, in the background, whenever a
//! session starts, the user writes to the agent, or a turn ends: they
//! long-poll diffd (`GET /api/wake`) for feedback on reviews of the agent's
//! working directory, then wake the agent the way its harness allows. One
//! waiter per session: each new one replaces the last. The agent stays free
//! to talk to its user directly meanwhile.
//!
//! - Claude Code: an `asyncRewake` hook that exits 2 wakes Claude with its stderr.
//! - Codex: `codex queue` adds the notice to the session, which starts a turn when idle.
//! - Anything else: `diffd hook wait` prints the notice and exits 2 (or `--json`).

use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;

use anyhow::Context;
use serde::Deserialize;

/// What the harness sends a hook on stdin (the fields diffd needs; Claude
/// Code and Codex both send these).
#[derive(Debug, Default, Deserialize)]
struct HookInput {
    session_id: Option<String>,
    cwd: Option<PathBuf>,
}

/// What `GET /api/wake` answers with.
type Notice = diffd_server::app::WakeNotice;

#[derive(Clone, Copy, Debug, PartialEq, Eq, clap::ValueEnum)]
pub enum Harness {
    Claude,
    Codex,
}

impl Harness {
    fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

fn read_input() -> HookInput {
    let mut raw = String::new();
    // No input (run by hand): fall back to the current directory, one waiter.
    if std::io::stdin().read_to_string(&mut raw).is_err() || raw.trim().is_empty() {
        return HookInput::default();
    }
    // Say what was wrong, but carry on as if run by hand: failing would show as an error in the harness.
    serde_json::from_str(&raw).unwrap_or_else(|e| {
        eprintln!("diffd hook: ignoring unreadable hook input: {e}");
        HookInput::default()
    })
}

/// The given working directory, or the current one.
fn cwd_of(cwd: Option<PathBuf>) -> PathBuf {
    cwd.or_else(|| std::env::current_dir().ok()).unwrap_or_else(|| PathBuf::from("."))
}

fn base(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Wait for feedback; `None` when there's nothing to wake for (the wait was
/// replaced by a newer one, timed out, or diffd isn't running).
async fn wait(port: u16, cwd: &std::path::Path, waiter: &str) -> anyhow::Result<Option<Notice>> {
    let client = reqwest::Client::new();
    let response =
        client.get(format!("{}/api/wake", base(port))).query(&[("cwd", cwd.to_string_lossy().as_ref()), ("waiter", waiter)]).send().await;
    let response = match response {
        Ok(r) => r,
        // diffd isn't running: nothing will be said, so nothing to wait for.
        Err(e) if e.is_connect() => return Ok(None),
        Err(e) => return Err(e).context("asking diffd for feedback"),
    };
    match response.status() {
        reqwest::StatusCode::OK => Ok(Some(response.json().await.context("reading diffd's notice")?)),
        reqwest::StatusCode::NO_CONTENT => Ok(None),
        status => anyhow::bail!("diffd answered {status}: {}", response.text().await.unwrap_or_default()),
    }
}

/// `diffd hook claude|codex`: wait, then wake the agent.
pub async fn wait_and_wake(harness: Harness, port: u16) -> anyhow::Result<ExitCode> {
    let input = read_input();
    let cwd = cwd_of(input.cwd.clone());
    let session = input.session_id.clone().unwrap_or_else(|| "default".into());
    let waiter = format!("{}:{session}", harness.name());
    let Some(notice) = wait(port, &cwd, &waiter).await? else {
        return Ok(ExitCode::SUCCESS);
    };
    match harness {
        // An asyncRewake hook exiting 2 wakes Claude with its stderr.
        Harness::Claude => {
            eprintln!("{}", notice.message);
            Ok(ExitCode::from(2))
        }
        Harness::Codex => {
            let session = input.session_id.context("Codex didn't say which session this is")?;
            let status = std::process::Command::new("codex")
                .args(["queue", "--thread", &session, "--message", &notice.message])
                .current_dir(&cwd)
                .stdout(std::process::Stdio::null())
                .status()
                .context("running `codex queue`")?;
            anyhow::ensure!(status.success(), "`codex queue` failed ({status})");
            Ok(ExitCode::SUCCESS)
        }
    }
}

/// `diffd hook end claude|codex`: the session ended, stop waiting for it.
pub async fn end(harness: Harness, port: u16) -> anyhow::Result<ExitCode> {
    let input = read_input();
    let waiter = format!("{}:{}", harness.name(), input.session_id.unwrap_or_else(|| "default".into()));
    // Best effort: if diffd is gone there's no waiter either.
    let _ = reqwest::Client::new().delete(format!("{}/api/wake", base(port))).query(&[("waiter", waiter)]).send().await;
    Ok(ExitCode::SUCCESS)
}

/// `diffd hook wait`: for any other harness or script.
pub async fn wait_generic(port: u16, cwd: Option<PathBuf>, session: String, json: bool) -> anyhow::Result<ExitCode> {
    let cwd = cwd_of(cwd);
    let Some(notice) = wait(port, &cwd, &format!("wait:{session}")).await? else {
        return Ok(ExitCode::SUCCESS);
    };
    if json {
        println!("{}", serde_json::to_string(&notice)?);
        Ok(ExitCode::SUCCESS)
    } else {
        eprintln!("{}", notice.message);
        Ok(ExitCode::from(2))
    }
}
