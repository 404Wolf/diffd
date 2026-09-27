//! A language server process and JSON-RPC over its stdio (LSP base protocol:
//! `Content-Length` framed JSON). Requests get their answers through
//! oneshot channels; the server's notifications go to a handler; its own
//! requests to us (`workspace/configuration` and friends) are answered by
//! another handler.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, bail};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot};

/// What the server sends us that isn't an answer.
pub enum Incoming {
    Notification {
        method: String,
        params: Value,
    },
    /// Answer by sending `Ok(result)` or `Err(message)` back.
    Request {
        method: String,
        params: Value,
        reply: oneshot::Sender<Result<Value, String>>,
    },
}

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

/// Bigger messages are taken as a broken stream rather than read.
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

pub struct Connection {
    outgoing: mpsc::UnboundedSender<Value>,
    pending: Pending,
    next_id: AtomicI64,
    child: Mutex<Option<Child>>,
    /// Cleared when the server's output ends: it exited or crashed.
    alive: Arc<AtomicBool>,
}

impl Connection {
    /// Start `command` in `root`; everything the server sends besides answers goes to `incoming`.
    pub fn spawn(
        command: &str,
        args: &[String],
        env: &std::collections::BTreeMap<String, String>,
        root: &Path,
        incoming: mpsc::UnboundedSender<Incoming>,
    ) -> anyhow::Result<Arc<Self>> {
        let mut child = Command::new(command)
            .args(args)
            .envs(env)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("starting `{command}`"))?;
        let stdin = child.stdin.take().context("no stdin")?;
        let stdout = child.stdout.take().context("no stdout")?;
        let (outgoing, rx) = mpsc::unbounded_channel();
        let alive = Arc::new(AtomicBool::new(true));
        let conn = Arc::new(Self {
            outgoing,
            pending: Arc::default(),
            next_id: AtomicI64::new(1),
            child: Mutex::new(Some(child)),
            alive: alive.clone(),
        });
        tokio::spawn(write_loop(stdin, rx));
        let (pending, outgoing) = (conn.pending.clone(), conn.outgoing.clone());
        tokio::spawn(async move {
            read_loop(BufReader::new(stdout), pending, outgoing, incoming).await;
            alive.store(false, Ordering::Release);
        });
        Ok(conn)
    }

    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> anyhow::Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().expect("rpc lock").insert(id, tx);
        if self.outgoing.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).is_err() {
            self.pending.lock().expect("rpc lock").remove(&id);
            bail!("the language server has exited");
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(message))) => bail!("{method}: {message}"),
            Ok(Err(_)) => bail!("the language server exited while answering {method}"),
            Err(_) => {
                self.pending.lock().expect("rpc lock").remove(&id);
                // Tell the server we've stopped waiting, so it can drop the work.
                self.notify("$/cancelRequest", json!({ "id": id }));
                bail!("{method} timed out after {}s", timeout.as_secs())
            }
        }
    }

    pub fn notify(&self, method: &str, params: Value) {
        let _ = self.outgoing.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Acquire) && !self.outgoing.is_closed()
    }

    /// Ask the server to stop, then make sure it does.
    pub async fn shutdown(&self) {
        let _ = self.request("shutdown", Value::Null, Duration::from_secs(2)).await;
        self.notify("exit", Value::Null);
        let child = self.child.lock().expect("rpc lock").take();
        if let Some(mut child) = child
            && tokio::time::timeout(Duration::from_secs(2), child.wait()).await.is_err()
        {
            let _ = child.kill().await;
        }
    }
}

async fn write_loop(mut stdin: ChildStdin, mut rx: mpsc::UnboundedReceiver<Value>) {
    while let Some(msg) = rx.recv().await {
        let body = msg.to_string();
        let frame = format!("Content-Length: {}\r\n\r\n{body}", body.len());
        if stdin.write_all(frame.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
            break;
        }
    }
}

async fn read_loop(
    mut stdout: BufReader<tokio::process::ChildStdout>,
    pending: Pending,
    outgoing: mpsc::UnboundedSender<Value>,
    incoming: mpsc::UnboundedSender<Incoming>,
) {
    loop {
        let msg = match read_message(&mut stdout).await {
            Ok(Frame::Message(msg)) => msg,
            Ok(Frame::End) => break,
            // A whole frame that isn't JSON: skip it, the stream is still in step.
            Ok(Frame::Malformed(e)) => {
                tracing::debug!(error = %e, "bad message from a language server");
                continue;
            }
            // The stream itself broke: nothing after this can be trusted.
            Err(e) => {
                tracing::debug!(error = %format!("{e:#}"), "language server output broke off");
                break;
            }
        };
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(Value::as_str).map(str::to_owned);
        match (id, method) {
            // An answer to one of our requests.
            (Some(id), None) => {
                let Some(id) = id.as_i64() else { continue };
                let Some(tx) = pending.lock().expect("rpc lock").remove(&id) else { continue };
                let result = match msg.get("error") {
                    Some(err) => Err(err.get("message").and_then(Value::as_str).unwrap_or("error").to_owned()),
                    None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = tx.send(result);
            }
            // The server asking us something.
            (Some(id), Some(method)) => {
                let (reply, answer) = oneshot::channel();
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                if incoming.send(Incoming::Request { method, params, reply }).is_err() {
                    break;
                }
                let outgoing = outgoing.clone();
                tokio::spawn(async move {
                    let body = match answer.await {
                        Ok(Ok(result)) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                        Ok(Err(message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": message } }),
                        // The handler went away without answering: an empty answer beats leaving the server waiting.
                        Err(_) => json!({ "jsonrpc": "2.0", "id": id, "result": Value::Null }),
                    };
                    let _ = outgoing.send(body);
                });
            }
            (None, Some(method)) => {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                if incoming.send(Incoming::Notification { method, params }).is_err() {
                    break;
                }
            }
            (None, None) => {}
        }
    }
    // The server exited: fail everything still waiting.
    pending.lock().expect("rpc lock").clear();
}

enum Frame {
    Message(Value),
    /// A complete frame whose body isn't JSON.
    Malformed(serde_json::Error),
    /// End of stream: the server exited.
    End,
}

/// One framed message. Errors mean the stream is broken (bad framing, I/O).
async fn read_message(r: &mut BufReader<tokio::process::ChildStdout>) -> anyhow::Result<Frame> {
    let mut length = None;
    loop {
        let mut line = String::new();
        if r.read_line(&mut line).await? == 0 {
            return Ok(Frame::End);
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some(v) = line.strip_prefix("Content-Length:") {
            length = Some(v.trim().parse::<usize>()?);
        }
    }
    let length = length.context("a message without Content-Length")?;
    if length > MAX_MESSAGE_BYTES {
        bail!("a {length}-byte message");
    }
    let mut body = vec![0; length];
    r.read_exact(&mut body).await?;
    Ok(match serde_json::from_slice(&body) {
        Ok(msg) => Frame::Message(msg),
        Err(e) => Frame::Malformed(e),
    })
}
