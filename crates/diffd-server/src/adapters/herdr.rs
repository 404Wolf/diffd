//! Optional pane presentation on the core local to this diffd, and agents'
//! inboxes there ([`AgentInbox`]). Every hc call is bounded, uses argv
//! directly, and never routes a target to a remote core.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};

use crate::app::HerdrView;
use crate::ports::{AgentInbox, InboxCore, Outgoing, Sent};

/// How long a show waits for a Herdr app to say what it did (`diffd.shown`).
/// The app looks at labels every 1.5 s.
const ACK_WAIT: Duration = Duration::from_secs(3);
const ACK_POLL: Duration = Duration::from_millis(500);

/// How long an inbox send may take. The core answers once the message is
/// queued and it has watched a moment for the agent to start working.
const SEND_TIMEOUT: Duration = Duration::from_secs(10);

/// hc's error kinds that mean the core never queued this key: it checks its
/// keys first, so `not_following` holds for earlier attempts too.
const REFUSALS: &[&str] = &["not_following", "invalid_params", "machine_unknown", "needs_target"];

/// hc's error kinds that mean it wasn't queued now, by a core (or hc) that
/// can't say whether an earlier attempt under the key was.
const UNVOUCHED: &[&str] = &[
    "other_core",     // the core this notice was for is gone
    "key_forgotten",  // the core may have queued it and forgotten the key
    "unknown_method", // a core that predates `terminal.queue`
    "usage",          // an hc that predates `--inbox-only --key`
    "not_found",      // the terminal, and its keys, were removed
    "finished",
];

#[derive(Deserialize)]
pub(crate) struct Core {
    pub id: String,
    pub name: String,
}

pub(crate) struct Herdr {
    program: PathBuf,
    send_timeout: Duration,
    ack_wait: Duration,
}

impl Default for Herdr {
    fn default() -> Self {
        Self { program: PathBuf::from("hc"), send_timeout: SEND_TIMEOUT, ack_wait: ACK_WAIT }
    }
}

/// What a show did, for the agent: whether Herdr is there, where the request
/// went, and what the app answered (`open`, `front`, `badge`, `closed`), or
/// `pending` when no app answered in time (it acts when one is opened, for a
/// while), or `none` when nothing was to be shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Shown {
    pub herdr: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub core_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shown: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl Shown {
    pub fn absent(reason: &str) -> Self {
        Self { herdr: false, terminal: None, core_id: None, seq: None, shown: None, reason: Some(reason.into()) }
    }
}

/// A request number per show: milliseconds, and never the same twice in this process,
/// so the app handles each request once and its answer names the request it is for.
fn next_seq() -> u64 {
    static LAST: AtomicU64 = AtomicU64::new(0);
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let mut last = LAST.load(Ordering::Relaxed);
    loop {
        let next = now.max(last + 1);
        match LAST.compare_exchange_weak(last, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return next,
            Err(seen) => last = seen,
        }
    }
}

/// The app's answer `<seq>:<state>`, when it is for this request.
fn answer_for(value: &str, seq: u64) -> Option<String> {
    let (of, state) = value.split_once(':')?;
    (of.parse::<u64>().ok()? == seq && matches!(state, "open" | "front" | "badge" | "closed")).then(|| state.to_owned())
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

impl Herdr {
    /// Ask the Herdr app to open (or front, badge, close) a review beside
    /// `terminal`, on `core` (this diffd's, from [`Herdr::core`]):
    /// `hc label <terminal> diffd.show=<view>:<review>:<seq>`. The app answers
    /// with `diffd.shown=<seq>:<state>`, which this waits for briefly. With
    /// no core there is no Herdr here: nothing is labelled.
    pub async fn show(&self, core: Option<&Core>, terminal: &str, review: &str, view: HerdrView) -> Shown {
        let Some(core) = core else { return Shown::absent("herdr-core isn't running here (no hc, or no core answered)") };
        let seq = next_seq();
        let mut shown = Shown {
            herdr: true,
            terminal: Some(terminal.to_owned()),
            core_id: Some(core.id.clone()),
            seq: Some(seq),
            shown: None,
            reason: None,
        };
        if !valid_terminal(terminal) || !valid_review(review) {
            shown.reason = Some("not a Herdr terminal or review id".into());
            return shown;
        }
        let label = format!("diffd.show={}:{review}:{seq}", view.as_str());
        if self.output(&["label", terminal, &label]).await.is_none() {
            shown.reason = Some(format!("could not label {terminal}: is it still open on this core?"));
            return shown;
        }
        if view == HerdrView::None {
            shown.shown = Some("none".into());
            return shown;
        }
        shown.shown = Some(self.answer(terminal, seq).await.unwrap_or_else(|| "pending".into()));
        shown
    }

    /// The app's answer to request `seq`, read from the terminal's labels until `ack_wait` passes.
    async fn answer(&self, terminal: &str, seq: u64) -> Option<String> {
        let until = Instant::now() + self.ack_wait;
        loop {
            if let Some(output) = self.output(&["get", terminal, "--json"]).await
                && let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout)
                && let Some(state) = value["labels"]["diffd.shown"].as_str().and_then(|v| answer_for(v, seq))
            {
                return Some(state);
            }
            if Instant::now() + ACK_POLL > until {
                return None;
            }
            tokio::time::sleep(ACK_POLL).await;
        }
    }
}

/// Review ids go into a label value split on `:`; diffd's own ids never hold one.
fn valid_review(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// Agents' inboxes on the local core.
pub fn inbox() -> Arc<dyn AgentInbox> {
    Arc::new(Herdr::default())
}

impl AgentInbox for Herdr {
    fn local_core(&self) -> BoxFuture<'_, Option<InboxCore>> {
        Box::pin(async move {
            let output = self.output(&["server", "status", "--json"]).await?;
            #[derive(Deserialize)]
            struct Status {
                core: Core,
                // A core that predates inbox-only messages lists no features.
                #[serde(default)]
                features: Vec<String>,
                #[serde(default)]
                queue_keys_kept_ms: u64,
            }
            let status = serde_json::from_slice::<Status>(&output.stdout).ok()?;
            Some(InboxCore {
                id: status.core.id,
                // Keys, or a retry could queue a notice twice.
                queues: status.features.iter().any(|f| f == "queue-keyed"),
                keys_kept: Duration::from_millis(status.queue_keys_kept_ms),
            })
        })
    }

    fn send<'a>(&'a self, notice: &'a Outgoing) -> BoxFuture<'a, Sent> {
        Box::pin(async move {
            if !valid_terminal(&notice.terminal) {
                return Sent::Refused;
            }
            // `--inbox-only` (`terminal.queue`): queued or refused, never typed;
            // queued once per key, by that core only. `--` keeps any text literal.
            let since = notice.since_ms.to_string();
            let args = [
                "send",
                "--inbox-only",
                "--core",
                &notice.core,
                "--key",
                &notice.key,
                "--key-since",
                &since,
                "--",
                &notice.terminal,
                &notice.text,
            ];
            let mut command = tokio::process::Command::new(&self.program);
            command.args(args).kill_on_drop(true);
            match tokio::time::timeout(self.send_timeout, command.output()).await {
                // It may have been queued before the answer was late.
                Err(_) => Sent::Unknown,
                // hc never ran: nothing here can speak for an earlier attempt.
                Ok(Err(_)) => Sent::Unvouched,
                Ok(Ok(output)) => outcome(&output),
            }
        })
    }
}

/// What `hc send --inbox-only` said: queued (`via: inbox`, `repeated` or
/// not), a refusal hc names, or anything else, which may have come after
/// the core queued it.
fn outcome(output: &std::process::Output) -> Sent {
    #[derive(Deserialize)]
    struct Answer {
        via: Option<String>,
    }
    #[derive(Deserialize)]
    struct Failure {
        error: Kind,
    }
    #[derive(Deserialize)]
    struct Kind {
        kind: String,
    }
    if output.status.success() {
        let queued = serde_json::from_slice::<Answer>(&output.stdout).is_ok_and(|a| a.via.as_deref() == Some("inbox"));
        return if queued { Sent::Queued } else { Sent::Unknown };
    }
    match serde_json::from_slice::<Failure>(&output.stderr) {
        Ok(failure) if REFUSALS.contains(&failure.error.kind.as_str()) => Sent::Refused,
        Ok(failure) if UNVOUCHED.contains(&failure.error.kind.as_str()) => Sent::Unvouched,
        _ => Sent::Unknown,
    }
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
        let hc = Herdr { program, ..Herdr::default() };
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

    /// A fake hc on a fake core: `send` records its argv and answers as hc
    /// would for each terminal; `server status` names core `core-1` with the
    /// given features.
    fn fake_core(dir: &Path, features: &str) -> Herdr {
        use std::os::unix::fs::PermissionsExt;
        let program = dir.join("hc");
        std::fs::write(
            &program,
            format!(
                r#"#!/bin/sh
cd -- "$(dirname -- "$0")"
case "$1" in
  server) printf '{{"core":{{"id":"core-1","name":"server"}}{features}}}' ;;
  send)
    printf '%s\n' "$@" > sent
    fail() {{ printf '{{"error":{{"kind":"%s","message":"no"}}}}' "$1" >&2; exit 1; }}
    case "${{10}}" in
      tinbox) printf '{{"status":"idle","turn":3,"started":true,"via":"inbox","waiting":1}}' ;;
      tagain) printf '{{"status":"idle","turn":3,"started":null,"via":"inbox","waiting":1,"repeated":true}}' ;;
      tnone) fail not_following ;;
      toldcore) fail unknown_method ;;
      tgone) fail other_core ;;
      tforgot) fail key_forgotten ;;
      toldhc) printf '{{"error":{{"kind":"usage","message":"unexpected argument --inbox-only"}}}}' >&2; exit 2 ;;
      tlost) fail unavailable ;;
      tgarbled) printf 'Segmentation fault' >&2; exit 139 ;;
      tnovia) printf '{{"status":"idle","turn":3,"started":true}}' ;;
      tslow) sleep 5 ;;
    esac ;;
esac
"#
            ),
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        Herdr { program, send_timeout: Duration::from_millis(500), ..Herdr::default() }
    }

    #[tokio::test]
    async fn the_core_says_whether_it_takes_inbox_only_messages() {
        let dir = tempfile::tempdir().unwrap();
        let hour = Duration::from_secs(3600);
        let keyed = fake_core(dir.path(), r#","features":["queue","queue-keyed"],"queue_keys_kept_ms":3600000"#).local_core().await;
        assert_eq!(keyed, Some(InboxCore { id: "core-1".into(), queues: true, keys_kept: hour }));
        let unkeyed = fake_core(dir.path(), r#","features":["framed","queue"]"#).local_core().await;
        assert!(unkeyed.is_some_and(|c| !c.queues), "queue without keys isn't enough: a retry could queue twice");
        let old = fake_core(dir.path(), "").local_core().await;
        assert!(old.is_some_and(|c| !c.queues), "a core that predates them lists no features");
        assert_eq!(Herdr { program: "/no/such/hc".into(), ..Herdr::default() }.local_core().await, None);
    }

    /// A fake core with terminals `tmanager` and `tworker` whose labels live in files
    /// (`<terminal>.<key>`); labelling `tmissing` fails, as for a stale terminal.
    fn fake_labels(dir: &Path, ack_wait: Duration) -> Herdr {
        use std::os::unix::fs::PermissionsExt;
        let program = dir.join("hc");
        std::fs::write(
            &program,
            r#"#!/bin/sh
cd -- "$(dirname -- "$0")"
case "$1" in
  label) [ "$2" != tmissing ] || exit 1; printf '%s\n' "$@" >> calls; printf '%s' "${3#*=}" > "$2.${3%%=*}" ;;
  get) printf '{"labels":{"diffd.shown":"%s"}}' "$(cat "$2.diffd.shown" 2>/dev/null)" ;;
esac
"#,
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        Herdr { program, ack_wait, ..Herdr::default() }
    }

    /// A Herdr app: once `diffd.show` is on `terminal`, it answers `<seq>:<state>` after `delay`.
    fn app_answers(dir: &Path, terminal: &str, state: &'static str, delay: Duration) -> tokio::task::JoinHandle<()> {
        let (asked, answer) = (dir.join(format!("{terminal}.diffd.show")), dir.join(format!("{terminal}.diffd.shown")));
        tokio::spawn(async move {
            let request = loop {
                if let Ok(request) = std::fs::read_to_string(&asked) {
                    break request;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            };
            tokio::time::sleep(delay).await;
            let seq = request.rsplit(':').next().unwrap().to_owned();
            std::fs::write(answer, format!("{seq}:{state}")).unwrap();
        })
    }

    fn core() -> Core {
        Core { id: "core-1".into(), name: "server".into() }
    }

    #[tokio::test]
    async fn a_show_labels_the_terminal_and_reports_what_the_app_did() {
        let dir = tempfile::tempdir().unwrap();
        let hc = fake_labels(dir.path(), Duration::from_secs(3));
        let app = app_answers(dir.path(), "tmanager", "badge", Duration::from_millis(700));
        let shown = hc.show(Some(&core()), "tmanager", "rabc23", HerdrView::Open).await;
        app.await.unwrap();
        let seq = shown.seq.unwrap();
        assert_eq!(
            shown,
            Shown {
                herdr: true,
                terminal: Some("tmanager".into()),
                core_id: Some("core-1".into()),
                seq: Some(seq),
                shown: Some("badge".into()),
                reason: None,
            }
        );
        let calls = std::fs::read_to_string(dir.path().join("calls")).unwrap();
        assert_eq!(calls, format!("label\ntmanager\ndiffd.show=open:rabc23:{seq}\n"), "argv is literal");
    }

    #[tokio::test]
    async fn without_an_answer_for_this_request_it_is_pending_within_the_bound() {
        let dir = tempfile::tempdir().unwrap();
        let hc = fake_labels(dir.path(), Duration::from_secs(1));
        // An answer to an earlier request is not this one's.
        std::fs::write(dir.path().join("tworker.diffd.shown"), "17:open").unwrap();
        let start = Instant::now();
        let shown = hc.show(Some(&core()), "tworker", "rabc23", HerdrView::Front).await;
        assert_eq!(shown.shown.as_deref(), Some("pending"));
        assert!(start.elapsed() < Duration::from_secs(2), "{:?}", start.elapsed());
        assert!(shown.herdr);
    }

    #[tokio::test]
    async fn no_core_stale_terminals_odd_ids_and_none_ask_nothing_of_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let hc = fake_labels(dir.path(), Duration::from_secs(3));
        let absent = hc.show(None, "tmanager", "rabc23", HerdrView::Open).await;
        assert!(!absent.herdr && absent.seq.is_none() && absent.reason.unwrap().contains("isn't running"));
        let stale = hc.show(Some(&core()), "tmissing", "rabc23", HerdrView::Open).await;
        assert!(stale.herdr && stale.shown.is_none() && stale.reason.unwrap().contains("tmissing"));
        for (terminal, review) in [("tmanager", "r:1"), ("tmanager", ""), ("--help", "rabc23")] {
            assert!(hc.show(Some(&core()), terminal, review, HerdrView::Open).await.shown.is_none(), "{terminal} {review}");
        }
        assert!(!dir.path().join("calls").exists(), "nothing was labelled");
        let start = Instant::now();
        let none = hc.show(Some(&core()), "tmanager", "rabc23", HerdrView::None).await;
        assert_eq!(none.shown.as_deref(), Some("none"));
        assert!(start.elapsed() < Duration::from_millis(400), "none waits for no answer");
        assert!(std::fs::read_to_string(dir.path().join("tmanager.diffd.show")).unwrap().starts_with("none:rabc23:"));
    }

    #[test]
    fn requests_are_numbered_once_and_answers_match_their_request() {
        let (a, b) = (next_seq(), next_seq());
        assert!(b > a);
        assert_eq!(answer_for(&format!("{b}:closed"), b).as_deref(), Some("closed"));
        for value in [format!("{a}:open"), format!("{b}:typed"), format!("{b}"), "x:open".into()] {
            assert_eq!(answer_for(&value, b), None, "{value}");
        }
    }

    fn outgoing(terminal: &str) -> Outgoing {
        let text = "--help; New feedback on your diffd review".to_owned();
        Outgoing { terminal: terminal.into(), core: "core-1".into(), key: "diffd-k1".into(), since_ms: 1_700_000_000_000, text }
    }

    #[tokio::test]
    async fn refused_unvouched_and_unknown_are_told_apart() {
        let dir = tempfile::tempdir().unwrap();
        let hc = fake_core(dir.path(), r#","features":["queue","queue-keyed"]"#);
        assert_eq!(hc.send(&outgoing("tinbox")).await, Sent::Queued);
        let sent = std::fs::read_to_string(dir.path().join("sent")).unwrap();
        let argv = "send\n--inbox-only\n--core\ncore-1\n--key\ndiffd-k1\n--key-since\n1700000000000\n--\ntinbox\n";
        assert_eq!(sent, format!("{argv}{}\n", outgoing("tinbox").text), "argv is literal, the text after --");
        assert_eq!(hc.send(&outgoing("tagain")).await, Sent::Queued, "queued before under that key");
        // The core vouches that it never queued this key.
        assert_eq!(hc.send(&outgoing("tnone")).await, Sent::Refused);
        // Not queued now, but nobody can speak for an earlier attempt.
        for terminal in ["tgone", "tforgot", "toldcore", "toldhc"] {
            assert_eq!(hc.send(&outgoing(terminal)).await, Sent::Unvouched, "{terminal}");
        }
        assert_eq!(Herdr { program: "/no/such/hc".into(), ..Herdr::default() }.send(&outgoing("tinbox")).await, Sent::Unvouched);
        // Maybe queued: a lost core, an unreadable failure, an answer without `via`, no answer in time.
        for terminal in ["tlost", "tgarbled", "tnovia", "tslow"] {
            assert_eq!(hc.send(&outgoing(terminal)).await, Sent::Unknown, "{terminal}");
        }
        std::fs::remove_file(dir.path().join("sent")).unwrap();
        assert_eq!(hc.send(&outgoing("t1;id")).await, Sent::Refused);
        assert!(!dir.path().join("sent").exists(), "an invalid address never reaches hc");
    }
}
