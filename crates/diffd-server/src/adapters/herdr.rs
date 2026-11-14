//! Optional pane presentation on the core local to this diffd. Every hc call
//! is bounded, uses argv directly, and never routes a target to a remote core.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use crate::app::Caller;

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

    /// A terminal's labels (`role`, `project`, …); `None` when hc doesn't know it.
    pub async fn labels(&self, terminal: &str) -> Option<BTreeMap<String, String>> {
        if !valid_terminal(terminal) {
            return None;
        }
        let output = self.output(&["get", terminal, "--json"]).await?;
        labels_of(&output.stdout)
    }

    /// Who is presenting from `terminal` (the caller's own, from its request):
    /// its role and project labels and this core's name, as far as hc can tell.
    pub async fn caller(&self, terminal: Option<String>, agent: Option<String>) -> Caller {
        let Some(terminal) = terminal.filter(|t| valid_terminal(t)) else {
            return Caller { agent, ..Caller::default() };
        };
        let (labels, core) = tokio::join!(self.labels(&terminal), self.core());
        let label = |key: &str| labels.as_ref().and_then(|l| l.get(key)).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty());
        Caller { role: label("role"), project: label("project"), machine: core.map(|c| c.name), terminal: Some(terminal), agent }
    }

    /// Only repair an old label that still points to this review. A newer
    /// review's label is untouched; failure to label the destination keeps the old one.
    pub async fn move_label(&self, old: Option<&str>, new: &str, review: &str, replacement: Option<&str>) -> bool {
        if !self.label(new, review).await {
            return false;
        }
        if let Some(old) = old.filter(|old| *old != new) {
            if let Some(output) = self.output(&["get", old, "--json"]).await {
                if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
                    if value["labels"]["diffd.review"].as_str() == Some(review) {
                        self.label(old, replacement.unwrap_or("")).await;
                    }
                }
            }
        }
        true
    }
}

/// The `labels` of `hc get --json`'s answer; values that aren't strings are left out.
fn labels_of(json: &[u8]) -> Option<BTreeMap<String, String>> {
    let value: serde_json::Value = serde_json::from_slice(json).ok()?;
    let labels = value.get("labels")?.as_object()?;
    Some(labels.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned()))).collect())
}

async fn output(program: &Path, args: &[&str]) -> Option<std::process::Output> {
    tokio::time::timeout(Duration::from_millis(500), tokio::process::Command::new(program).args(args).kill_on_drop(true).output())
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

    #[test]
    fn labels_come_from_hc_get() {
        let json = br#"{"address":"t1n7","labels":{"role":"worker","project":"herdr-android","n":3},"argv":["claude"]}"#;
        let labels = labels_of(json).unwrap();
        assert_eq!(labels.get("role").map(String::as_str), Some("worker"));
        assert_eq!(labels.get("project").map(String::as_str), Some("herdr-android"));
        assert!(!labels.contains_key("n"));
        assert!(labels_of(b"{}").is_none());
        assert!(labels_of(b"not json").is_none());
    }

    #[tokio::test]
    async fn a_caller_without_a_terminal_asks_hc_nothing() {
        let hc = Herdr { program: PathBuf::from("/no/such/hc") };
        let caller = hc.caller(None, Some("Claude".into())).await;
        assert_eq!(caller, Caller { agent: Some("Claude".into()), ..Caller::default() });
        let caller = hc.caller(Some("t1n7".into()), None).await;
        assert_eq!(caller, Caller { terminal: Some("t1n7".into()), ..Caller::default() }, "hc unavailable: no labels, no machine");
        assert_eq!(hc.caller(Some("--help".into()), None).await.terminal, None);
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
}
