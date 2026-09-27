//! Language servers for open reviews: keeping the reviewed files open in
//! them, routing their diagnostics to pages, and answering the page's
//! definition / type definition / hover questions.
//!
//! Only reviews of the working tree get this: language servers see files on
//! disk, which is exactly the new side of such a review. And only while a page
//! shows the review: servers start when the first page opens it and stop soon
//! after the last one closes, so a busy agent with nobody watching (or a big
//! workspace's worth of servers) costs nothing.

use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::Duration;

use diffd_core::model::{CodeAnswer, CodeQuery, FileStatus, ReviewId};
use diffd_core::protocol::ServerMsg;
use tokio::sync::broadcast::error::RecvError;

use super::{App, Live, Result, nested};
use crate::ports::{CodeIntel, FileDiagnostics};

/// Files opened in language servers per review, for diagnostics.
const MAX_SYNCED_FILES: usize = 300;

/// How long servers outlive the last page of a review: a reload or a dropped
/// connection shouldn't restart them.
pub const VIEW_GRACE: Duration = Duration::from_secs(30);

/// A page showing a review, for as long as it's held (see [`App::view`]).
pub struct Viewing {
    app: Weak<App>,
    id: ReviewId,
}

impl Drop for Viewing {
    fn drop(&mut self) {
        let Some(app) = self.app.upgrade() else { return };
        let id = self.id.clone();
        tokio::spawn(async move { app.unview(&id, VIEW_GRACE).await });
    }
}

impl App {
    /// Use these language servers; their diagnostics flow to pages from now on.
    pub fn set_code_intel(&self, intel: Arc<dyn CodeIntel>) {
        let mut rx = intel.diagnostics();
        *self.code.lock().expect("code lock") = Some(intel);
        let me = self.me.clone();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(d) => match me.upgrade() {
                        Some(app) => app.route_diagnostics(d),
                        None => return,
                    },
                    Err(RecvError::Lagged(n)) => tracing::warn!(n, "dropped language server diagnostics"),
                    Err(RecvError::Closed) => return,
                }
            }
        });
    }

    fn intel(&self) -> Option<Arc<dyn CodeIntel>> {
        self.code.lock().expect("code lock").clone()
    }

    /// The repository root for language servers, or `None` when the review isn't of the working tree.
    async fn code_root(&self, id: &ReviewId, live: &Live) -> Option<PathBuf> {
        if let Some(root) = live.inner.lock().expect("live lock").code_root.clone() {
            return Some(root);
        }
        let (meta, _) = self.meta(id).await.ok()?;
        if meta.to.is_some() {
            return None;
        }
        let root = tokio::fs::canonicalize(&meta.repo_path).await.ok()?;
        live.inner.lock().expect("live lock").code_root = Some(root.clone());
        Some(root)
    }

    /// A page opened the review: count it as viewing (until the guard is dropped) and
    /// open the review's files in language servers, so diagnostics arrive.
    pub async fn view(&self, id: &ReviewId) -> Result<Viewing> {
        let live = self.live(id).await?;
        live.inner.lock().expect("live lock").viewers += 1;
        let viewing = Viewing { app: self.me.clone(), id: id.clone() };
        self.attach_code(id, &live).await;
        Ok(viewing)
    }

    /// A page closed the review. If none is left after `grace`, and no other viewed
    /// review shares its repository, stop its language servers.
    pub async fn unview(&self, id: &ReviewId, grace: Duration) {
        let Ok(live) = self.live(id).await else { return };
        let left = {
            let mut inner = live.inner.lock().expect("live lock");
            inner.viewers = inner.viewers.saturating_sub(1);
            inner.viewers
        };
        if left > 0 {
            return;
        }
        tokio::time::sleep(grace).await;
        let Some(intel) = self.intel() else { return };
        let (viewed, root) = {
            let inner = live.inner.lock().expect("live lock");
            (inner.viewers > 0, inner.code_root.clone())
        };
        let Some(root) = root.filter(|_| !viewed) else { return };
        let shared = self.lives().iter().any(|l| {
            let inner = l.inner.lock().expect("live lock");
            inner.viewers > 0 && inner.code_root.as_ref().is_some_and(|r| nested(r, &root))
        });
        if !shared {
            intel.release(&root).await;
        }
    }

    async fn attach_code(&self, id: &ReviewId, live: &Live) {
        let paths: Vec<String> = App::snapshot(live)
            .files
            .iter()
            .filter(|f| f.omitted.is_none() && f.new.is_some() && f.status != FileStatus::Deleted)
            .map(|f| f.path.clone())
            .take(MAX_SYNCED_FILES)
            .collect();
        self.sync_code(id, live, paths).await;
    }

    /// Tell language servers these files (may have) changed, if a page shows the
    /// review (otherwise nothing starts them). Runs in the background.
    pub(super) async fn sync_code(&self, id: &ReviewId, live: &Live, paths: Vec<String>) {
        if live.inner.lock().expect("live lock").viewers == 0 {
            return;
        }
        let Some(intel) = self.intel() else { return };
        let Some(root) = self.code_root(id, live).await else { return };
        tokio::spawn(async move {
            for path in paths {
                intel.sync(&root, &path).await;
            }
        });
    }

    /// Ask a language server about a position on the new side of a file.
    pub async fn code(&self, id: &ReviewId, query: CodeQuery, path: &str, line: u32, col: u32) -> Result<CodeAnswer> {
        let live = self.live(id).await?;
        let Some(intel) = self.intel() else {
            return Ok(CodeAnswer::Unavailable { reason: "language servers are turned off".into() });
        };
        let Some(root) = self.code_root(id, &live).await else {
            return Ok(CodeAnswer::Unavailable { reason: "language servers only run for reviews of the working tree".into() });
        };
        if path.starts_with('/') || path.split('/').any(|p| p == "..") {
            return Ok(CodeAnswer::Unavailable { reason: "only files in the repository can be asked about".into() });
        }
        let answer = intel.ask(&root, path, query, line, col).await;
        if let CodeAnswer::Locations { locations } = &answer {
            // The page may now open these, even outside the repository (a library's source).
            let mut inner = live.inner.lock().expect("live lock");
            inner.external_paths.extend(locations.iter().filter(|l| l.external).map(|l| l.path.clone()));
        }
        Ok(answer)
    }

    /// Whether the page may open this absolute path (a language server pointed at it).
    pub(super) async fn external_allowed(&self, id: &ReviewId, path: &str) -> bool {
        match self.live(id).await {
            Ok(live) => live.inner.lock().expect("live lock").external_paths.contains(path),
            Err(_) => false,
        }
    }

    /// Remember a file the page opened for context, and keep it open in its language server.
    pub(super) async fn watch_context(&self, id: &ReviewId, path: &str) {
        let Ok(live) = self.live(id).await else { return };
        live.inner.lock().expect("live lock").context_paths.insert(path.to_owned());
        self.sync_code(id, &live, vec![path.to_owned()]).await;
    }

    /// Hand a file's diagnostics to every open review that shows it.
    fn route_diagnostics(&self, d: FileDiagnostics) {
        for live in self.lives() {
            let path = {
                let inner = live.inner.lock().expect("live lock");
                let Some(rel) = inner.code_root.as_ref().and_then(|root| d.path.strip_prefix(root).ok()) else { continue };
                let rel = rel.to_string_lossy().into_owned();
                let shown = inner.snapshot.files.iter().any(|f| f.path == rel) || inner.context_paths.contains(&rel);
                if !shown || inner.diagnostics.get(&rel).map_or(d.diagnostics.is_empty(), |old| *old == d.diagnostics) {
                    continue;
                }
                rel
            };
            live.inner.lock().expect("live lock").diagnostics.insert(path.clone(), d.diagnostics.clone());
            App::broadcast(&live, ServerMsg::Diagnostics { path, diagnostics: d.diagnostics.clone() });
        }
    }
}
