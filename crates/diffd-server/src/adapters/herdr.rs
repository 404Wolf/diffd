//! Optional pane presentation on the core local to this diffd, and agents'
//! inboxes there ([`AgentInbox`]). Presentation talks to the running core over
//! its socket, never starting one; inbox sends use hc. Every call is bounded,
//! and no target is ever routed to a remote core.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::app::HerdrView;
use crate::ports::{AgentInbox, InboxCore, Outgoing, Sent};

/// How long a show waits, in all, for a Herdr app to say what it did
/// (`diffd.shown.<seq>`). The app looks at labels every 1.5 s.
const ACK_WAIT: Duration = Duration::from_secs(3);
const ACK_POLL: Duration = Duration::from_millis(500);
/// The longest one call to the core may take (connecting included).
const CALL: Duration = Duration::from_millis(500);

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

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Core {
    pub id: String,
    pub name: String,
}

pub(crate) struct Herdr {
    program: PathBuf,
    send_timeout: Duration,
    ack_wait: Duration,
    /// The core's socket; `None`: where herdr-core puts it ([`core_socket`]).
    socket: Option<PathBuf>,
}

impl Default for Herdr {
    fn default() -> Self {
        Self { program: PathBuf::from("hc"), send_timeout: SEND_TIMEOUT, ack_wait: ACK_WAIT, socket: None }
    }
}

/// What a show did, for the agent: whether Herdr is there, where the request
/// went, and what the app answered (`open`, `front`, `badge`, `closed`), or
/// `pending` when no app answered in time (it acts when one is opened, for a
/// while), or `none` when nothing was to be shown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct Shown {
    pub herdr: bool,
    /// The review's labels went on (`present_review`'s `labelled`).
    #[serde(skip)]
    pub labelled: bool,
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

pub(crate) const NO_CORE: &str = "herdr-core isn't running here: nothing to show it in";
pub(crate) const REPLACED: &str = "the Herdr core it was presented on was replaced: present it again (present_in)";

impl Shown {
    pub fn absent(reason: &str) -> Self {
        Self { herdr: false, labelled: false, terminal: None, core_id: None, seq: None, shown: None, reason: Some(reason.into()) }
    }

    /// A core runs, but not the one the review's terminal belongs to: nothing labelled.
    pub fn replaced(core: &Core, terminal: &str) -> Self {
        Self { terminal: Some(terminal.into()), core_id: Some(core.id.clone()), ..Self::absent(REPLACED) }
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

/// The app answers each request under its own label, `diffd.shown.<seq>`: the core's
/// label write is unconditional and answers come from separate processes (and maybe two
/// windows), so a shared label could go backwards; a key per request can't.
fn answer_key(seq: u64) -> String {
    format!("diffd.shown.{seq}")
}

/// Request `seq`'s answer among a terminal's labels, when it is one the app gives.
fn answer_for(labels: &Value, seq: u64) -> Option<String> {
    let state = labels[answer_key(seq)].as_str()?;
    matches!(state, "open" | "front" | "badge" | "closed").then(|| state.to_owned())
}

/// Review ids go into a label value split on `:`; diffd's own ids never hold one.
fn valid_review(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 && value.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
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

/// Where this user's herdr-core listens, worked out as herdr-core's own
/// `Paths::from_env` does on Unix (`paths.rs`; `platform/unix.rs` `endpoints`):
/// `HC_SOCKET`, else `socket` in its `config.toml`, else
/// `$XDG_RUNTIME_DIR/herdr-core/<session>.sock` (`/run/user/<uid>` when that is
/// unset but exists), else beside its state; `<session>` is `HC_SESSION` or `default`.
fn core_socket(var: impl Fn(&str) -> Option<String>) -> PathBuf {
    let set = |name: &str| var(name).filter(|v| !v.is_empty());
    if let Some(socket) = set("HC_SOCKET") {
        return PathBuf::from(socket);
    }
    let session = set("HC_SESSION").map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).unwrap_or_else(|| "default".into());
    let home = PathBuf::from(var("HOME").unwrap_or_else(|| "/".into()));
    let config = set("XDG_CONFIG_HOME").map_or_else(|| home.join(".config"), PathBuf::from).join("herdr-core").join("config.toml");
    let configured = std::fs::read_to_string(config)
        .ok()
        .and_then(|text| text.parse::<toml::Table>().ok())
        .and_then(|table| table.get("socket").and_then(|v| v.as_str()).map(PathBuf::from));
    if let Some(socket) = configured {
        return socket;
    }
    let state = set("XDG_STATE_HOME").map_or_else(|| home.join(".local/state"), PathBuf::from).join("herdr-core").join(&session);
    let run = set("XDG_RUNTIME_DIR").map(PathBuf::from).or_else(runtime_dir);
    run.map_or(state, |run| run.join("herdr-core")).join(format!("{session}.sock"))
}

#[cfg(unix)]
fn runtime_dir() -> Option<PathBuf> {
    use std::os::unix::fs::MetadataExt;
    let uid = std::fs::metadata("/proc/self").ok()?.uid();
    Some(PathBuf::from(format!("/run/user/{uid}"))).filter(|p| p.is_dir())
}

#[cfg(not(unix))]
fn runtime_dir() -> Option<PathBuf> {
    None
}

/// One plain-mode connection to the running core: one JSON-RPC message per
/// line, answered in order (herdr-core `server.rs` `connection`, the protocol
/// `client::call` speaks). Connecting never starts a core, unlike every hc
/// command but `server stop` (`cli.rs` `call` uses `client::connect_or_start`;
/// on Unix `server status` does too, since `platform::status_may_start_core`
/// is true there). And every call on it reaches the same core process: after
/// its id is checked, a replacement core (a new process, whose short addresses
/// may name other terminals) can't receive the writes that follow.
#[cfg(unix)]
struct Session {
    lines: tokio::io::Lines<tokio::io::BufReader<tokio::net::unix::OwnedReadHalf>>,
    write: tokio::net::unix::OwnedWriteHalf,
    next: u64,
    broken: bool,
}

#[cfg(unix)]
impl Session {
    async fn open(socket: &Path) -> Option<Self> {
        use tokio::io::AsyncBufReadExt;
        let stream = tokio::time::timeout(CALL, tokio::net::UnixStream::connect(socket)).await.ok()?.ok()?;
        let (read, write) = stream.into_split();
        Some(Self { lines: tokio::io::BufReader::new(read).lines(), write, next: 0, broken: false })
    }

    /// One call's result, or `None` for an error, a late answer or a lost core.
    /// After a late or unreadable answer the connection is out of step: it is not used again.
    async fn call(&mut self, method: &str, params: Value) -> Option<Value> {
        use tokio::io::AsyncWriteExt;
        if self.broken {
            return None;
        }
        self.next += 1;
        let id = self.next;
        let line = format!("{}\n", json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        let (write, lines) = (&mut self.write, &mut self.lines);
        let reply = tokio::time::timeout(CALL, async move {
            write.write_all(line.as_bytes()).await.ok()?;
            let reply: Value = serde_json::from_str(&lines.next_line().await.ok()??).ok()?;
            (reply["id"] == id).then_some(reply)
        })
        .await
        .ok()
        .flatten();
        let Some(reply) = reply else {
            self.broken = true;
            return None;
        };
        reply.get("error").is_none().then(|| reply["result"].clone())
    }

    async fn status(&mut self) -> Option<Value> {
        self.call("server.status", json!({})).await
    }

    async fn label(&mut self, terminal: &str, labels: BTreeMap<&str, &str>) -> bool {
        self.call("terminal.label", json!({ "terminal": terminal, "labels": labels })).await.is_some()
    }

    async fn labels(&mut self, terminal: &str) -> Option<Value> {
        self.call("terminal.get", json!({ "terminal": terminal })).await.map(|t| t["labels"].clone())
    }
}

#[cfg(not(unix))]
struct Session;

#[cfg(not(unix))]
impl Session {
    /// Presentation needs the Unix socket; elsewhere there is no Herdr to show in.
    async fn open(_socket: &Path) -> Option<Self> {
        None
    }
    async fn status(&mut self) -> Option<Value> {
        None
    }
    async fn label(&mut self, _terminal: &str, _labels: BTreeMap<&str, &str>) -> bool {
        false
    }
    async fn labels(&mut self, _terminal: &str) -> Option<Value> {
        None
    }
}

impl Herdr {
    #[cfg(test)]
    pub(crate) fn for_tests(socket: PathBuf, program: PathBuf, ack_wait: Duration) -> Self {
        Self { program, ack_wait, socket: Some(socket), ..Self::default() }
    }

    async fn session(&self) -> Option<Session> {
        let socket = self.socket.clone().unwrap_or_else(|| core_socket(|name| std::env::var(name).ok()));
        Session::open(&socket).await
    }

    /// This machine's core, if one is running (it is never started).
    pub async fn core(&self) -> Option<Core> {
        serde_json::from_value(self.session().await?.status().await?["core"].clone()).ok()
    }

    /// Present a review beside `terminal` and ask the Herdr app to show it as
    /// `view`, on the core with id `core` (the one the caller checked): on one
    /// connection, the core's id is checked again, then `diffd.review=<review>`
    /// and `diffd.show=<view>:<review>:<seq>` go on in one `terminal.label`
    /// (applied under one lock with one labels event, herdr-core `api.rs`
    /// `terminal_label`, so no window sees one without the other). `moved_from`
    /// (the old terminal and the review it should show now) is repaired only if
    /// its label still names this review. Then the app's answer,
    /// `diffd.shown.<seq>=<state>`, is awaited for at most `ack_wait`. Without
    /// that core nothing is labelled.
    pub async fn present(
        &self,
        core: &str,
        terminal: &str,
        review: &str,
        view: HerdrView,
        moved_from: Option<(&str, Option<&str>)>,
    ) -> Shown {
        let Some(mut session) = self.session().await else { return Shown::absent(NO_CORE) };
        let Some(running) = session.status().await.and_then(|s| serde_json::from_value::<Core>(s["core"].clone()).ok()) else {
            return Shown::absent(NO_CORE);
        };
        if running.id != core {
            return Shown::replaced(&running, terminal);
        }
        let seq = next_seq();
        let mut shown = Shown {
            herdr: true,
            labelled: false,
            terminal: Some(terminal.to_owned()),
            core_id: Some(running.id),
            seq: Some(seq),
            shown: None,
            reason: None,
        };
        if !valid_terminal(terminal) || !valid_review(review) {
            shown.reason = Some("not a Herdr terminal or review id".into());
            return shown;
        }
        let request = format!("{}:{review}:{seq}", view.as_str());
        if !session.label(terminal, BTreeMap::from([("diffd.review", review), ("diffd.show", request.as_str())])).await {
            shown.reason = Some(format!("could not label {terminal}: is it still open on this core?"));
            return shown;
        }
        shown.labelled = true;
        if let Some((old, replacement)) = moved_from.filter(|(old, _)| *old != terminal && valid_terminal(old))
            && session.labels(old).await.is_some_and(|labels| labels["diffd.review"].as_str() == Some(review))
        {
            session.label(old, BTreeMap::from([("diffd.review", replacement.unwrap_or(""))])).await;
        }
        if view == HerdrView::None {
            shown.shown = Some("none".into());
            return shown;
        }
        // One bound for the whole wait, a slow read included.
        let answer = tokio::time::timeout(self.ack_wait, async {
            loop {
                if let Some(labels) = session.labels(terminal).await
                    && let Some(state) = answer_for(&labels, seq)
                {
                    return state;
                }
                tokio::time::sleep(ACK_POLL).await;
            }
        })
        .await;
        shown.shown = Some(answer.unwrap_or_else(|_| "pending".into()));
        shown
    }
}

/// Agents' inboxes on the local core.
pub fn inbox() -> Arc<dyn AgentInbox> {
    Arc::new(Herdr::default())
}

impl AgentInbox for Herdr {
    fn local_core(&self) -> BoxFuture<'_, Option<InboxCore>> {
        Box::pin(async move {
            // Over the socket: `hc server status` would start a core that isn't running.
            let status = self.session().await?.status().await?;
            #[derive(Deserialize)]
            struct Status {
                core: Core,
                // A core that predates inbox-only messages lists no features.
                #[serde(default)]
                features: Vec<String>,
                #[serde(default)]
                queue_keys_kept_ms: u64,
            }
            let status = serde_json::from_value::<Status>(status).ok()?;
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

/// A fake herdr-core for tests: a Unix socket speaking the plain line protocol
/// (`server.status`, `terminal.label`, `terminal.get`), recording every call.
#[cfg(test)]
pub(crate) mod fake {
    use std::collections::{BTreeMap, VecDeque};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[derive(Default)]
    pub struct State {
        /// The id each `server.status` answers, in turn; the last one stays.
        pub ids: VecDeque<String>,
        pub features: Vec<String>,
        pub labels: BTreeMap<String, BTreeMap<String, String>>,
        /// Every call: (connection number, method, params).
        pub calls: Vec<(usize, String, Value)>,
        /// Terminals that don't exist (labelling them fails).
        pub missing: Vec<String>,
        /// The app: when a `diffd.show` arrives, answer `diffd.shown.<seq>=<state>` after a delay.
        pub app: Option<(&'static str, Duration)>,
        /// Each `terminal.get` takes this long.
        pub slow_get: Option<Duration>,
        /// Hang up right after answering `server.status`.
        pub hang_up_after_status: bool,
        connections: usize,
    }

    pub type Core = Arc<Mutex<State>>;

    pub fn core(id: &str) -> Core {
        Arc::new(Mutex::new(State { ids: VecDeque::from([id.to_owned()]), ..State::default() }))
    }

    /// Listen at `<dir>/core.sock`.
    pub fn listen(dir: &Path, core: Core) -> PathBuf {
        let path = dir.join("core.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(serve(stream, core.clone()));
            }
        });
        path
    }

    pub fn calls(core: &Core, method: &str) -> Vec<Value> {
        core.lock().unwrap().calls.iter().filter(|(_, m, _)| m == method).map(|(_, _, p)| p.clone()).collect()
    }

    pub fn label(core: &Core, terminal: &str, key: &str) -> Option<String> {
        core.lock().unwrap().labels.get(terminal)?.get(key).cloned()
    }

    async fn serve(stream: tokio::net::UnixStream, core: Core) {
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        let connection = {
            let mut state = core.lock().unwrap();
            state.connections += 1;
            state.connections
        };
        while let Ok(Some(line)) = lines.next_line().await {
            let request: Value = serde_json::from_str(&line).unwrap();
            let (method, params) = (request["method"].as_str().unwrap().to_owned(), request["params"].clone());
            let slow = {
                let mut state = core.lock().unwrap();
                state.calls.push((connection, method.clone(), params.clone()));
                state.slow_get.filter(|_| method == "terminal.get")
            };
            if let Some(slow) = slow {
                tokio::time::sleep(slow).await;
            }
            let (result, hang_up) = {
                let mut state = core.lock().unwrap();
                let terminal = params["terminal"].as_str().unwrap_or_default().to_owned();
                match method.as_str() {
                    "server.status" => {
                        let id = if state.ids.len() > 1 { state.ids.pop_front().unwrap() } else { state.ids[0].clone() };
                        (
                            Ok(
                                json!({ "core": { "id": id, "name": "server" }, "features": state.features, "queue_keys_kept_ms": 3_600_000 }),
                            ),
                            state.hang_up_after_status,
                        )
                    }
                    "terminal.label" if state.missing.contains(&terminal) => (Err("not_found"), false),
                    "terminal.label" => {
                        let set = params["labels"].as_object().unwrap().clone();
                        let labels = state.labels.entry(terminal.clone()).or_default();
                        for (key, value) in &set {
                            match value.as_str().unwrap() {
                                "" => labels.remove(key),
                                value => labels.insert(key.clone(), value.to_owned()),
                            };
                        }
                        if let (Some(show), Some((answer, delay))) = (set.get("diffd.show").and_then(Value::as_str), state.app) {
                            let seq = show.rsplit(':').next().unwrap().to_owned();
                            let core = core.clone();
                            tokio::spawn(async move {
                                tokio::time::sleep(delay).await;
                                core.lock()
                                    .unwrap()
                                    .labels
                                    .entry(terminal)
                                    .or_default()
                                    .insert(format!("diffd.shown.{seq}"), answer.to_owned());
                            });
                        }
                        (Ok(json!({})), false)
                    }
                    "terminal.get" => (Ok(json!({ "labels": state.labels.get(&terminal).cloned().unwrap_or_default() })), false),
                    _ => (Err("unknown_method"), false),
                }
            };
            let reply = match result {
                Ok(result) => json!({ "jsonrpc": "2.0", "id": request["id"], "result": result }),
                Err(kind) => {
                    json!({ "jsonrpc": "2.0", "id": request["id"], "error": { "code": -32000, "message": kind, "data": { "kind": kind } } })
                }
            };
            if write.write_all(format!("{reply}\n").as_bytes()).await.is_err() || hang_up {
                return;
            }
        }
    }
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
    fn the_socket_is_found_where_herdr_core_puts_it() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| pairs.iter().find(|(k, _)| *k == name).map(|(_, v)| (*v).to_owned())
        };
        assert_eq!(core_socket(env(&[("HC_SOCKET", "/s/core.sock"), ("XDG_RUNTIME_DIR", "/run/user/7")])), PathBuf::from("/s/core.sock"));
        assert_eq!(
            core_socket(env(&[("XDG_RUNTIME_DIR", "/run/user/7"), ("HOME", "/nowhere")])),
            PathBuf::from("/run/user/7/herdr-core/default.sock")
        );
        assert_eq!(
            core_socket(env(&[("XDG_RUNTIME_DIR", "/run/user/7"), ("HC_SESSION", "lab"), ("HOME", "/nowhere")])),
            PathBuf::from("/run/user/7/herdr-core/lab.sock")
        );
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("herdr-core")).unwrap();
        std::fs::write(dir.path().join("herdr-core/config.toml"), "socket = \"/elsewhere/c.sock\"\n").unwrap();
        let config = dir.path().to_string_lossy().into_owned();
        let with_config = move |name: &str| match name {
            "XDG_CONFIG_HOME" => Some(config.clone()),
            "XDG_RUNTIME_DIR" => Some("/run/user/7".into()),
            _ => None,
        };
        assert_eq!(core_socket(with_config), PathBuf::from("/elsewhere/c.sock"), "the config's socket");
    }

    /// No core: no socket listening. hc is a fake that records any run.
    fn no_core(dir: &Path) -> Herdr {
        use std::os::unix::fs::PermissionsExt;
        let program = dir.join("hc");
        std::fs::write(&program, "#!/bin/sh\nprintf '%s\\n' \"$@\" >> \"$(dirname \"$0\")/ran\"\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        Herdr::for_tests(dir.join("no-core.sock"), program, ACK_WAIT)
    }

    #[tokio::test]
    async fn without_a_running_core_nothing_runs_and_nothing_is_started() {
        let dir = tempfile::tempdir().unwrap();
        let hc = no_core(dir.path());
        let start = std::time::Instant::now();
        assert!(hc.core().await.is_none());
        assert!(hc.local_core().await.is_none());
        let shown = hc.present("core-1", "tmanager", "rabc23", HerdrView::Open, Some(("tworker", None))).await;
        assert!(!shown.herdr && !shown.labelled && shown.reason.as_deref() == Some(NO_CORE));
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(!dir.path().join("ran").exists(), "no hc ran: hc would start a core");
        assert!(!dir.path().join("no-core.sock").exists(), "and none was started");
    }

    fn herdr(socket: PathBuf, ack_wait: Duration) -> Herdr {
        Herdr::for_tests(socket, PathBuf::from("/no/such/hc"), ack_wait)
    }

    #[tokio::test]
    async fn both_labels_go_on_in_one_call_and_the_answer_is_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let core = fake::core("core-1");
        core.lock().unwrap().app = Some(("badge", Duration::from_millis(700)));
        let hc = herdr(fake::listen(dir.path(), core.clone()), ACK_WAIT);
        assert_eq!(hc.core().await.map(|c| c.id).as_deref(), Some("core-1"));
        let shown = hc.present("core-1", "tmanager", "rabc23", HerdrView::Open, None).await;
        let seq = shown.seq.unwrap();
        assert_eq!(
            shown,
            Shown {
                herdr: true,
                labelled: true,
                terminal: Some("tmanager".into()),
                core_id: Some("core-1".into()),
                seq: Some(seq),
                shown: Some("badge".into()),
                reason: None,
            }
        );
        let labels = fake::calls(&core, "terminal.label");
        assert_eq!(labels.len(), 1, "one call: no window sees the review without its request");
        assert_eq!(
            labels[0],
            serde_json::json!({ "terminal": "tmanager", "labels": { "diffd.review": "rabc23", "diffd.show": format!("open:rabc23:{seq}") } })
        );
        // The status check and the write are on one connection: one core process.
        let state = core.lock().unwrap();
        let on: Vec<_> = state.calls.iter().filter(|(_, m, _)| m != "terminal.get").map(|(c, m, _)| (*c, m.clone())).collect();
        assert_eq!(on, [(1, "server.status".to_owned()), (2, "server.status".to_owned()), (2, "terminal.label".to_owned())]);
    }

    #[tokio::test]
    async fn a_replaced_core_gets_no_label() {
        let dir = tempfile::tempdir().unwrap();
        // Checked as core-1 by the caller, then replaced: the write's own check sees core-2.
        let core = fake::core("core-2");
        let hc = herdr(fake::listen(dir.path(), core.clone()), ACK_WAIT);
        let shown = hc.present("core-1", "tmanager", "rabc23", HerdrView::Open, Some(("tworker", None))).await;
        assert!(!shown.labelled && shown.reason.as_deref() == Some(REPLACED), "{shown:?}");
        assert!(fake::calls(&core, "terminal.label").is_empty() && fake::calls(&core, "terminal.get").is_empty());
        // A core lost after its check (the connection ends): nothing reaches another one.
        let dir = tempfile::tempdir().unwrap();
        let core = fake::core("core-1");
        core.lock().unwrap().hang_up_after_status = true;
        let hc = herdr(fake::listen(dir.path(), core.clone()), ACK_WAIT);
        let shown = hc.present("core-1", "tmanager", "rabc23", HerdrView::Open, None).await;
        assert!(!shown.labelled && shown.shown.is_none(), "{shown:?}");
        assert!(fake::calls(&core, "terminal.label").is_empty());
    }

    #[tokio::test]
    async fn moving_repairs_the_old_terminal_only_while_it_names_this_review() {
        let dir = tempfile::tempdir().unwrap();
        let core = fake::core("core-1");
        let hc = herdr(fake::listen(dir.path(), core.clone()), Duration::from_millis(100));
        let set = |t: &str, review: &str| {
            core.lock().unwrap().labels.entry(t.into()).or_default().insert("diffd.review".into(), review.into());
        };
        set("tworker", "moved");
        assert!(hc.present("core-1", "tmanager", "moved", HerdrView::Open, Some(("tworker", None))).await.labelled);
        assert_eq!(fake::label(&core, "tmanager", "diffd.review").as_deref(), Some("moved"));
        assert_eq!(fake::label(&core, "tworker", "diffd.review"), None, "cleared");
        set("tworker", "moved");
        hc.present("core-1", "tmanager", "moved", HerdrView::Open, Some(("tworker", Some("remaining")))).await;
        assert_eq!(fake::label(&core, "tworker", "diffd.review").as_deref(), Some("remaining"));
        set("tworker", "newer");
        hc.present("core-1", "tmanager", "moved", HerdrView::Open, Some(("tworker", Some("remaining")))).await;
        assert_eq!(fake::label(&core, "tworker", "diffd.review").as_deref(), Some("newer"), "another review's label stays");
        set("tworker", "moved");
        core.lock().unwrap().missing.push("tmissing".into());
        let failed = hc.present("core-1", "tmissing", "moved", HerdrView::Open, Some(("tworker", None))).await;
        assert!(!failed.labelled && failed.reason.unwrap().contains("tmissing"));
        assert_eq!(fake::label(&core, "tworker", "diffd.review").as_deref(), Some("moved"), "a failed destination keeps the old one");
        hc.present("core-1", "tworker", "moved", HerdrView::Open, Some(("tworker", None))).await;
        assert_eq!(fake::label(&core, "tworker", "diffd.review").as_deref(), Some("moved"), "same pane: never cleared");
    }

    #[tokio::test]
    async fn the_wait_is_bounded_even_when_reads_are_slow() {
        for slow in [None, Some(Duration::from_millis(450))] {
            let dir = tempfile::tempdir().unwrap();
            let core = fake::core("core-1");
            core.lock().unwrap().slow_get = slow;
            // Another request's answer, older or newer (and the old shared label), is not this one's.
            core.lock().unwrap().labels.entry("tworker".into()).or_default().insert("diffd.shown.17".into(), "open".into());
            core.lock().unwrap().labels.entry("tworker".into()).or_default().insert("diffd.shown.9999999999999".into(), "open".into());
            core.lock().unwrap().labels.entry("tworker".into()).or_default().insert("diffd.shown".into(), "17:open".into());
            let hc = herdr(fake::listen(dir.path(), core.clone()), Duration::from_millis(1000));
            let start = std::time::Instant::now();
            let shown = hc.present("core-1", "tworker", "rabc23", HerdrView::Front, None).await;
            assert_eq!(shown.shown.as_deref(), Some("pending"));
            // Connect, status and label are quick here; the wait itself stops at 1 s.
            assert!(start.elapsed() < Duration::from_millis(1200), "{slow:?}: {:?}", start.elapsed());
        }
    }

    #[tokio::test]
    async fn odd_ids_and_none_ask_nothing_of_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let core = fake::core("core-1");
        let hc = herdr(fake::listen(dir.path(), core.clone()), ACK_WAIT);
        for (terminal, review) in [("tmanager", "r:1"), ("tmanager", ""), ("--help", "rabc23")] {
            assert!(!hc.present("core-1", terminal, review, HerdrView::Open, None).await.labelled, "{terminal} {review}");
        }
        assert!(fake::calls(&core, "terminal.label").is_empty());
        let start = std::time::Instant::now();
        let none = hc.present("core-1", "tmanager", "rabc23", HerdrView::None, None).await;
        assert_eq!(none.shown.as_deref(), Some("none"));
        assert!(start.elapsed() < Duration::from_millis(400), "none waits for no answer");
        assert!(fake::label(&core, "tmanager", "diffd.show").unwrap().starts_with("none:rabc23:"));
        assert!(fake::calls(&core, "terminal.get").is_empty());
    }

    #[test]
    fn requests_are_numbered_once_and_answers_match_their_request() {
        let (a, b) = (next_seq(), next_seq());
        assert!(b > a);
        let labels = serde_json::json!({ answer_key(b): "closed", answer_key(a): "open", "diffd.shown": format!("{b}:open") });
        assert_eq!(answer_for(&labels, b).as_deref(), Some("closed"), "its own key, never another request's");
        assert_eq!(answer_for(&labels, a).as_deref(), Some("open"));
        assert_eq!(answer_for(&serde_json::json!({ answer_key(b): "typed" }), b), None);
        assert_eq!(
            answer_for(&serde_json::json!({ "diffd.shown": format!("{b}:open") }), b),
            None,
            "the old shared label is not an answer"
        );
    }

    #[tokio::test]
    async fn the_core_says_whether_it_takes_inbox_only_messages() {
        let hour = Duration::from_secs(3600);
        for (features, queues) in [(vec!["queue", "queue-keyed"], true), (vec!["framed", "queue"], false), (vec![], false)] {
            let dir = tempfile::tempdir().unwrap();
            let core = fake::core("core-1");
            core.lock().unwrap().features = features.iter().map(|f| f.to_string()).collect();
            let hc = herdr(fake::listen(dir.path(), core), ACK_WAIT);
            // Queue without keys isn't enough (a retry could queue twice); an old core lists no features.
            assert_eq!(hc.local_core().await, Some(InboxCore { id: "core-1".into(), queues, keys_kept: hour }), "{features:?}");
        }
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(no_core(dir.path()).local_core().await, None);
    }

    /// A fake hc: `send` records its argv and answers as hc would for each terminal.
    fn fake_core(dir: &Path) -> Herdr {
        use std::os::unix::fs::PermissionsExt;
        let program = dir.join("hc");
        std::fs::write(
            &program,
            r#"#!/bin/sh
cd -- "$(dirname -- "$0")"
case "$1" in
  send)
    printf '%s\n' "$@" > sent
    fail() { printf '{"error":{"kind":"%s","message":"no"}}' "$1" >&2; exit 1; }
    case "${10}" in
      tinbox) printf '{"status":"idle","turn":3,"started":true,"via":"inbox","waiting":1}' ;;
      tagain) printf '{"status":"idle","turn":3,"started":null,"via":"inbox","waiting":1,"repeated":true}' ;;
      tnone) fail not_following ;;
      toldcore) fail unknown_method ;;
      tgone) fail other_core ;;
      tforgot) fail key_forgotten ;;
      toldhc) printf '{"error":{"kind":"usage","message":"unexpected argument --inbox-only"}}' >&2; exit 2 ;;
      tlost) fail unavailable ;;
      tgarbled) printf 'Segmentation fault' >&2; exit 139 ;;
      tnovia) printf '{"status":"idle","turn":3,"started":true}' ;;
      tslow) sleep 5 ;;
    esac ;;
esac
"#,
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        Herdr { program, send_timeout: Duration::from_millis(500), ..Herdr::default() }
    }

    fn outgoing(terminal: &str) -> Outgoing {
        let text = "--help; New feedback on your diffd review".to_owned();
        Outgoing { terminal: terminal.into(), core: "core-1".into(), key: "diffd-k1".into(), since_ms: 1_700_000_000_000, text }
    }

    #[tokio::test]
    async fn refused_unvouched_and_unknown_are_told_apart() {
        let dir = tempfile::tempdir().unwrap();
        let hc = fake_core(dir.path());
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
