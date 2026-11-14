//! Optional pane presentation on the core local to this diffd, and agents'
//! inboxes there ([`AgentInbox`]). Every hc call is bounded, uses argv
//! directly, and never routes a target to a remote core.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use serde::Deserialize;

use crate::ports::AgentInbox;

/// How long an inbox send may take. The core answers once the message is
/// queued and it has watched a moment for the agent to start working.
const SEND_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Deserialize)]
pub(crate) struct Core {
    pub id: String,
    pub name: String,
}

pub(crate) struct Herdr {
    program: PathBuf,
}

impl Default for Herdr {
    fn default() -> Self {
        Self { program: PathBuf::from("hc") }
    }
}

pub(crate) fn valid_terminal(value: &str) -> bool {
    value.len() > 1
        && value.len() <= 32
        && value.starts_with('t')
        && value[1..].bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// Accept qualified addresses only when their core name matches this server.
/// Strip that prefix before hc, so even a local alias can never route remotely.
pub(crate) fn target(value: &str, core: Option<&Core>) -> Result<String, String> {
    let terminal = match value.split_once('/') {
        Some((machine, terminal)) if core.is_some_and(|c| c.name == machine) => terminal,
        Some(_) => return Err("present_in must be on this diffd's core. For another machine, call that machine's diffd; use an unqualified t-address for this core.".into()),
        None => value,
    };
    if !valid_terminal(terminal) {
        return Err("present_in must be a Herdr terminal address, e.g. t2r (or this core's name/t2r).".into());
    }
    Ok(terminal.to_owned())
}

impl Herdr {
    async fn output(&self, args: &[&str]) -> Option<std::process::Output> {
        output(&self.program, args).await
    }

    pub async fn core(&self) -> Option<Core> {
        let output = self.output(&["server", "status", "--json"]).await?;
        #[derive(Deserialize)]
        struct Status {
            core: Core,
        }
        serde_json::from_slice::<Status>(&output.stdout).ok().map(|status| status.core)
    }

    pub async fn label(&self, terminal: &str, review: &str) -> bool {
        let success = self.output(&["label", terminal, &format!("diffd.review={review}")]).await.is_some();
        if !success {
            tracing::debug!(terminal, review, "could not label the presentation terminal");
        }
        success
    }

    /// Only repair an old label that still points to this review. A newer
    /// review's label is untouched; failure to label the destination keeps the old one.
    pub async fn move_label(&self, old: Option<&str>, new: &str, review: &str, replacement: Option<&str>) -> bool {
        if !self.label(new, review).await {
            return false;
        }
        if let Some(old) = old.filter(|old| *old != new)
            && let Some(output) = self.output(&["get", old, "--json"]).await
            && let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout)
            && value["labels"]["diffd.review"].as_str() == Some(review)
        {
            self.label(old, replacement.unwrap_or("")).await;
        }
        true
    }
}

/// Agents' inboxes on the local core.
pub fn inbox() -> Arc<dyn AgentInbox> {
    Arc::new(Herdr::default())
}

impl AgentInbox for Herdr {
    fn core_id(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move { self.core().await.map(|core| core.id) })
    }

    fn send<'a>(&'a self, terminal: &'a str, text: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            if !valid_terminal(terminal) {
                return false;
            }
            // `--inbox-only`: queued, or refused (`not_following`), never typed.
            // An hc without inboxes refuses the flag. `--` keeps any text literal.
            let args = ["send", "--inbox-only", "--", terminal, text];
            let Some(output) = output_within(&self.program, &args, SEND_TIMEOUT).await else {
                return false;
            };
            queued(&output.stdout)
        })
    }
}

/// Whether `hc send`'s JSON answer says the message went into the inbox.
fn queued(stdout: &[u8]) -> bool {
    #[derive(Deserialize)]
    struct Sent {
        via: Option<String>,
    }
    serde_json::from_slice::<Sent>(stdout).is_ok_and(|sent| sent.via.as_deref() == Some("inbox"))
}

async fn output(program: &Path, args: &[&str]) -> Option<std::process::Output> {
    output_within(program, args, Duration::from_millis(500)).await
}

async fn output_within(program: &Path, args: &[&str], limit: Duration) -> Option<std::process::Output> {
    tokio::time::timeout(limit, tokio::process::Command::new(program).args(args).kill_on_drop(true).output())
        .await
        .ok()?
        .ok()
        .filter(|o| o.status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_stay_on_the_local_core() {
        let core = Core { id: "core-id".into(), name: "server".into() };
        for value in ["t1", "t2r", "tabc123"] {
            assert_eq!(target(value, None).unwrap(), value);
        }
        assert_eq!(target("server/t2r", Some(&core)).unwrap(), "t2r");
        for value in ["", "t", "--help", "t2r\n", "${HC_TERMINAL_ID}", "t☃", "t;id", "server/t2r/other"] {
            assert!(target(value, Some(&core)).is_err(), "{value}");
        }
        assert!(target("laptop/t2r", Some(&core)).unwrap_err().contains("that machine's diffd"));
        assert!(target("server/t2r", None).is_err(), "a qualified address needs a known local core");
    }

    #[tokio::test]
    async fn hc_failure_is_optional_and_bounded_and_arguments_are_literal() {
        assert!(output(Path::new("/no/such/hc"), &["label", "t1", "diffd.review=test"]).await.is_none());
        let start = std::time::Instant::now();
        assert!(output(Path::new("sh"), &["-c", "exec sleep 10"]).await.is_none());
        assert!(start.elapsed() < Duration::from_secs(2));
        let out = output(Path::new("printf"), &["%s\n", "label", "t2r", "diffd.review=example"]).await.unwrap();
        assert_eq!(String::from_utf8(out.stdout).unwrap(), "label\nt2r\ndiffd.review=example\n");
    }

    #[tokio::test]
    async fn moving_a_label_preserves_other_reviews_and_failed_destinations() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("hc");
        // The test process owns this fake core. No environment mutation or live terminals.
        std::fs::write(
            &program,
            r#"#!/bin/sh
cd -- "$(dirname -- "$0")"
case "$1" in
  label) [ "$2" != tmissing ] || exit 1; printf '%s' "${3#diffd.review=}" > "$2" ;;
  get) printf '{"labels":{"diffd.review":"%s"}}' "$(cat "$2")" ;;
esac
"#,
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        let hc = Herdr { program };
        let read = |t: &str| std::fs::read_to_string(dir.path().join(t)).unwrap();
        hc.label("tworker", "moved").await;
        assert!(hc.move_label(Some("tworker"), "tmanager", "moved", None).await);
        assert_eq!(read("tmanager"), "moved");
        assert_eq!(read("tworker"), "");
        hc.label("tworker", "moved").await;
        hc.move_label(Some("tworker"), "tmanager", "moved", Some("remaining")).await;
        assert_eq!(read("tworker"), "remaining");
        hc.label("tworker", "newer").await;
        hc.move_label(Some("tworker"), "tmanager", "moved", Some("remaining")).await;
        assert_eq!(read("tworker"), "newer");
        hc.label("tworker", "moved").await;
        assert!(!hc.move_label(Some("tworker"), "tmissing", "moved", None).await);
        assert_eq!(read("tworker"), "moved");
        hc.move_label(Some("tworker"), "tworker", "moved", None).await;
        assert_eq!(read("tworker"), "moved", "same-pane presentation never clears its own label");
    }

    /// A fake hc: `send` records its argv and answers as the core would for
    /// the terminal (`tinbox` follows its inbox, `tnone` doesn't, `told`
    /// is a core without inboxes); `server status` names core `core-1`.
    fn fake_core(dir: &Path) -> Herdr {
        use std::os::unix::fs::PermissionsExt;
        let program = dir.join("hc");
        std::fs::write(
            &program,
            r#"#!/bin/sh
cd -- "$(dirname -- "$0")"
case "$1" in
  server) printf '{"core":{"id":"core-1","name":"server"}}' ;;
  send)
    printf '%s\n' "$@" > sent
    case "$4" in
      tinbox) printf '{"status":"idle","turn":3,"started":true,"via":"inbox","waiting":1}' ;;
      tnone) printf '{"error":{"kind":"not_following","message":"nothing follows tnone'"'"'s inbox; nothing was typed"}}' >&2; exit 1 ;;
      told) printf '{"error":{"kind":"usage","message":"unexpected argument --inbox-only"}}' >&2; exit 2 ;;
      ttyped) printf '{"status":"idle","turn":3,"started":true}' ;;
    esac ;;
esac
"#,
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        Herdr { program }
    }

    #[tokio::test]
    async fn the_inbox_takes_messages_only_when_the_core_queued_them() {
        let dir = tempfile::tempdir().unwrap();
        let hc = fake_core(dir.path());
        assert_eq!(hc.core_id().await.as_deref(), Some("core-1"));
        let text = "--help; New feedback on your diffd review";
        assert!(hc.send("tinbox", text).await);
        let sent = std::fs::read_to_string(dir.path().join("sent")).unwrap();
        assert_eq!(sent, format!("send\n--inbox-only\n--\ntinbox\n{text}\n"), "argv is literal, the text after --");
        assert!(!hc.send("tnone", text).await, "nothing follows that inbox");
        assert!(!hc.send("told", text).await, "a core without inboxes refuses the flag");
        assert!(!hc.send("ttyped", text).await, "an answer that doesn't say inbox isn't a queued message");
        std::fs::remove_file(dir.path().join("sent")).unwrap();
        assert!(!hc.send("t1;id", text).await);
        assert!(!dir.path().join("sent").exists(), "an invalid address never reaches hc");
        assert!(!Herdr { program: "/no/such/hc".into() }.send("tinbox", text).await);
    }
