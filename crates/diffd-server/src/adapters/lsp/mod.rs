//! Language servers, run for the files of open reviews: one process per
//! configured server and project root, started on first use, stopped when
//! idle, restarted if it crashes (a few times). Several run at once when a
//! diff mixes languages.

mod convert;
mod rpc;

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use diffd_core::model::{CodeAnswer, CodeQuery};
use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};

use crate::config::{Config, LanguageServer};
use crate::ports::{CodeIntel, FileDiagnostics};
use rpc::{Connection, Incoming};

/// Files larger than this aren't sent to language servers.
const MAX_FILE_BYTES: u64 = 3 * 1024 * 1024;
/// How long a server may take to start up.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(60);
/// A server that crashes this many times is left off until diffd restarts.
const MAX_CRASHES: u32 = 3;

pub struct LspPool {
    config: Arc<Config>,
    /// One slot per server, each with its own lock: starting one server (which
    /// can take a while) doesn't hold up questions to the others.
    servers: Mutex<HashMap<Key, Arc<tokio::sync::Mutex<Option<Slot>>>>>,
    diagnostics: broadcast::Sender<FileDiagnostics>,
}

/// A server is per (configured server name, project root).
type Key = (String, PathBuf);

enum Slot {
    Running(Arc<Server>),
    /// Couldn't start (not installed?) or kept crashing: the reason, for the page.
    Broken(String),
}

struct Server {
    conn: Arc<Connection>,
    /// Open documents: version and a hash of the text last sent.
    open: Mutex<HashMap<PathBuf, (i32, u64)>>,
    last_used: Mutex<Instant>,
    crashes: u32,
    /// The server asked for `didSave` (some crash on notifications they didn't ask for).
    wants_save: bool,
}

impl LspPool {
    pub fn new(config: Arc<Config>) -> Arc<Self> {
        let pool = Arc::new(Self { config, servers: Default::default(), diagnostics: broadcast::channel(1024).0 });
        let weak = Arc::downgrade(&pool);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(60));
            loop {
                tick.tick().await;
                let Some(pool) = weak.upgrade() else { return };
                pool.stop_idle().await;
            }
        });
        pool
    }

    fn timeout(&self) -> Duration {
        Duration::from_secs(self.config.lsp.request_timeout_secs)
    }

    /// The running server for a file, starting it if needed, with the language id to open the file as.
    async fn server_for(&self, repo_root: &Path, path: &str) -> Result<(Arc<Server>, String), String> {
        if !self.config.lsp.enabled {
            return Err("language servers are turned off in the config".into());
        }
        let Some((name, spec, language)) = self.config.server_for(path) else {
            let ext = Path::new(path).extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_else(|| path.to_owned());
            return Err(format!("no language server is set up for {ext} files"));
        };
        let root = project_root(repo_root, path, &spec.root_markers);
        let key = (name.to_owned(), root.clone());
        let cell = self.servers.lock().expect("lsp lock").entry(key).or_default().clone();
        let mut slot = cell.lock().await;
        let crashes = match &*slot {
            Some(Slot::Running(s)) if s.conn.alive() => {
                *s.last_used.lock().expect("lsp lock") = Instant::now();
                return Ok((s.clone(), language.to_owned()));
            }
            Some(Slot::Running(s)) => s.crashes + 1,
            Some(Slot::Broken(reason)) => return Err(reason.clone()),
            None => 0,
        };
        if crashes >= MAX_CRASHES {
            let reason = format!("{name} keeps crashing; restart diffd to try again");
            *slot = Some(Slot::Broken(reason.clone()));
            return Err(reason);
        }
        match self.start(name, spec, &root, crashes).await {
            Ok(server) => {
                tracing::info!(server = name, root = %root.display(), "language server started");
                *slot = Some(Slot::Running(server.clone()));
                Ok((server, language.to_owned()))
            }
            Err(e) => {
                let reason = format!("{name} isn't available: {e:#}");
                tracing::warn!("{reason}");
                *slot = Some(Slot::Broken(reason.clone()));
                Err(reason)
            }
        }
    }

    async fn start(&self, name: &str, spec: &LanguageServer, root: &Path, crashes: u32) -> anyhow::Result<Arc<Server>> {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let conn = Connection::spawn(&spec.command, &spec.args, &spec.env, root, tx)?;
        let settings = spec.settings.clone().map(toml_to_json).unwrap_or(Value::Null);

        // Everything the server says that isn't an answer.
        let diagnostics = self.diagnostics.clone();
        let folders = json!([{ "uri": convert::file_uri(root), "name": root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() }]);
        let server_name = name.to_owned();
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                match msg {
                    Incoming::Notification { method, params } if method == "textDocument/publishDiagnostics" => {
                        if let Some((path, diagnostics_)) = convert::diagnostics(&params) {
                            let _ = diagnostics.send(FileDiagnostics { path, diagnostics: diagnostics_ });
                        }
                    }
                    Incoming::Notification { .. } => {}
                    Incoming::Request { method, params, reply } => {
                        let answer = match method.as_str() {
                            "workspace/configuration" => Ok(convert::configuration(&params, &settings)),
                            "workspace/workspaceFolders" => Ok(folders.clone()),
                            "window/workDoneProgress/create"
                            | "client/registerCapability"
                            | "client/unregisterCapability"
                            | "window/showMessageRequest"
                            | "workspace/diagnostic/refresh"
                            | "workspace/semanticTokens/refresh"
                            | "workspace/inlayHint/refresh" => Ok(Value::Null),
                            other => {
                                tracing::debug!(server = %server_name, method = other, "unsupported request from a language server");
                                Err(format!("diffd doesn't support {other}"))
                            }
                        };
                        let _ = reply.send(answer);
                    }
                }
            }
        });

        let init = json!({
            "processId": std::process::id(),
            "clientInfo": { "name": "diffd", "version": env!("CARGO_PKG_VERSION") },
            "rootUri": convert::file_uri(root),
            "rootPath": root,
            "workspaceFolders": [{ "uri": convert::file_uri(root), "name": root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default() }],
            "initializationOptions": spec.initialization_options.clone().map(toml_to_json),
            "capabilities": {
                "general": { "positionEncodings": ["utf-16"] },
                "textDocument": {
                    "synchronization": { "didSave": true, "dynamicRegistration": false },
                    "definition": { "linkSupport": true },
                    "typeDefinition": { "linkSupport": true },
                    "hover": { "contentFormat": ["markdown", "plaintext"] },
                    "publishDiagnostics": { "relatedInformation": false, "versionSupport": false },
                },
                "workspace": { "configuration": true, "workspaceFolders": true },
                "window": { "workDoneProgress": true },
            },
        });
        let init = conn.request("initialize", init, INITIALIZE_TIMEOUT).await?;
        let sync = &init["capabilities"]["textDocumentSync"];
        let wants_save = sync.get("save").is_some_and(|s| s.as_bool() != Some(false));
        conn.notify("initialized", json!({}));
        // Some servers (pyright) only start working once they've been sent settings, even empty ones.
        let settings = spec.settings.clone().map(toml_to_json).unwrap_or_else(|| json!({}));
        conn.notify("workspace/didChangeConfiguration", json!({ "settings": settings }));
        Ok(Arc::new(Server { conn, open: Mutex::default(), last_used: Mutex::new(Instant::now()), crashes, wants_save }))
    }

    /// Send a file's current text to its server (open, or change).
    async fn sync_file(&self, repo_root: &Path, path: &str) -> Result<(Arc<Server>, PathBuf), String> {
        let (server, language) = self.server_for(repo_root, path).await?;
        let file = repo_root.join(path);
        let meta = tokio::fs::metadata(&file).await.map_err(|e| format!("can't read {path}: {e}"))?;
        if meta.len() > MAX_FILE_BYTES {
            return Err(format!("{path} is too large for the language server"));
        }
        let text = String::from_utf8_lossy(&tokio::fs::read(&file).await.map_err(|e| e.to_string())?).into_owned();
        let hash = {
            let mut h = DefaultHasher::new();
            text.hash(&mut h);
            h.finish()
        };
        let uri = convert::file_uri(&file);
        let sent = {
            let mut open = server.open.lock().expect("lsp lock");
            match open.get(&file).copied() {
                None => {
                    open.insert(file.clone(), (1, hash));
                    Some(("open", 1))
                }
                Some((version, old)) if old != hash => {
                    open.insert(file.clone(), (version + 1, hash));
                    Some(("change", version + 1))
                }
                Some(_) => None,
            }
        };
        match sent {
            Some(("open", _)) => server.conn.notify(
                "textDocument/didOpen",
                json!({ "textDocument": { "uri": uri, "languageId": language, "version": 1, "text": text } }),
            ),
            Some((_, version)) => server.conn.notify(
                "textDocument/didChange",
                json!({ "textDocument": { "uri": uri, "version": version }, "contentChanges": [{ "text": text }] }),
            ),
            None => return Ok((server, file)),
        }
        // Some servers (rust-analyzer's cargo check) only report on save; the file on disk is saved.
        if server.wants_save {
            server.conn.notify("textDocument/didSave", json!({ "textDocument": { "uri": uri } }));
        }
        Ok((server, file))
    }

    async fn ask_inner(&self, repo_root: &Path, path: &str, query: CodeQuery, line: u32, col: u32) -> CodeAnswer {
        let (server, file) = match self.sync_file(repo_root, path).await {
            Ok(s) => s,
            Err(reason) => return CodeAnswer::Unavailable { reason },
        };
        let method = match query {
            CodeQuery::Definition => "textDocument/definition",
            CodeQuery::TypeDefinition => "textDocument/typeDefinition",
            CodeQuery::Hover => "textDocument/hover",
        };
        let params = json!({ "textDocument": { "uri": convert::file_uri(&file) }, "position": convert::position(line, col) });
        match server.conn.request(method, params, self.timeout()).await {
            Ok(result) => match query {
                CodeQuery::Hover => match convert::hover_markdown(&result) {
                    Some(markdown) => CodeAnswer::Hover { markdown },
                    None => CodeAnswer::Unavailable { reason: "nothing to show here".into() },
                },
                CodeQuery::Definition | CodeQuery::TypeDefinition => {
                    let root = repo_root.canonicalize().unwrap_or_else(|_| repo_root.to_path_buf());
                    CodeAnswer::Locations { locations: convert::locations(&result, &root) }
                }
            },
            Err(e) => CodeAnswer::Unavailable { reason: format!("{e:#}") },
        }
    }

    async fn stop_idle(&self) {
        let idle = Duration::from_secs(self.config.lsp.idle_timeout_secs);
        let cells: Vec<_> = self.servers.lock().expect("lsp lock").values().cloned().collect();
        for cell in cells {
            // A server that's busy starting isn't idle.
            let Ok(mut slot) = cell.try_lock() else { continue };
            let idle_server = matches!(&*slot, Some(Slot::Running(s)) if s.last_used.lock().expect("lsp lock").elapsed() > idle);
            if idle_server && let Some(Slot::Running(s)) = slot.take() {
                drop(slot);
                s.conn.shutdown().await;
            }
        }
    }
}

impl CodeIntel for LspPool {
    fn sync<'a>(&'a self, repo_root: &'a Path, path: &'a str) -> BoxFuture<'a, ()> {
        async move {
            if let Err(reason) = self.sync_file(repo_root, path).await {
                tracing::debug!(path, reason, "not synced with a language server");
            }
        }
        .boxed()
    }

    fn ask<'a>(&'a self, repo_root: &'a Path, path: &'a str, query: CodeQuery, line: u32, col: u32) -> BoxFuture<'a, CodeAnswer> {
        self.ask_inner(repo_root, path, query, line, col).boxed()
    }

    fn diagnostics(&self) -> broadcast::Receiver<FileDiagnostics> {
        self.diagnostics.subscribe()
    }
}

/// The nearest folder above `path` (inside the repository) holding one of
/// `markers`, else the repository root.
fn project_root(repo_root: &Path, path: &str, markers: &[String]) -> PathBuf {
    let mut dir = repo_root.join(path);
    while dir.pop() && dir.starts_with(repo_root) {
        if markers.iter().any(|m| dir.join(m).exists()) {
            return dir;
        }
        if dir == repo_root {
            break;
        }
    }
    repo_root.to_path_buf()
}

fn toml_to_json(v: toml::Value) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_roots() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("web/src")).unwrap();
        std::fs::write(root.join("web/package.json"), "{}").unwrap();
        std::fs::write(root.join("Cargo.toml"), "").unwrap();
        let markers = |m: &[&str]| m.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(project_root(root, "web/src/a.ts", &markers(&["package.json"])), root.join("web"));
        assert_eq!(project_root(root, "src/lib.rs", &markers(&["Cargo.toml"])), root);
        assert_eq!(project_root(root, "x.py", &markers(&["pyproject.toml"])), root, "no marker: the repository root");
    }
}
