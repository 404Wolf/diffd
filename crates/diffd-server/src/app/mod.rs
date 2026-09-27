//! Use cases. Everything the page or the agent can do goes through [`App`].

mod code;
mod context;
mod conversation;
mod feedback;
mod history;
mod rebuild;
mod share;
mod wake;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use diffd_core::feedback::FeedbackGate;
use diffd_core::model::{History, Millis, Presence, ReviewId, ReviewMeta, Snapshot};
use diffd_core::protocol::{ReviewState, ServerMsg};
use tokio::sync::{Notify, broadcast};

pub use conversation::{NoteInput, RegionInput};
pub use feedback::{FeedbackBatch, FeedbackItem, ThreadMessage};
pub use history::RangeEnd;
pub use share::{ShareRequest, ShareResult};
pub use wake::{WakeNotice, WakeReview};

use crate::adapters::store::Store;
use crate::ports::{Clock, CodeIntel, DiffEngine, RepoSource, TreeWatch};

/// Agents that haven't called a tool for this long are shown as away.
const AWAY_AFTER_MS: Millis = 10 * 60 * 1000;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

pub type Result<T> = std::result::Result<T, AppError>;

/// Reviews updated within this long are watched again right after a restart.
const RESUME_WITHIN_MS: Millis = 7 * 24 * 60 * 60 * 1000;

pub struct App {
    store: Store,
    repo: Arc<dyn RepoSource>,
    engine: Arc<dyn DiffEngine>,
    clock: Arc<dyn Clock>,
    base_url: String,
    live: Mutex<HashMap<ReviewId, Arc<Live>>>,
    /// Follows working trees; set by whoever owns the watcher.
    watcher: Mutex<Option<Arc<dyn TreeWatch>>>,
    /// Language servers, when configured (see [`App::set_code_intel`]).
    code: Mutex<Option<Arc<dyn CodeIntel>>>,
    /// Harness hooks waiting to wake their agent (see `wake`).
    waiters: Mutex<wake::Waiters>,
    /// Held while diffing commits ahead of time (see `history`), so background
    /// work never takes more than one diff's worth of the machine.
    prefetching: tokio::sync::Mutex<()>,
    me: Weak<App>,
}

/// In-memory state for a review that someone is looking at or working on.
pub(crate) struct Live {
    pub(crate) tx: broadcast::Sender<ServerMsg>,
    pub(crate) feedback: Notify,
    pub(crate) rebuild: tokio::sync::Mutex<()>,
    /// Held while handing feedback to the agent, so two waits never both get the same messages.
    pub(crate) deliver: tokio::sync::Mutex<()>,
    inner: Mutex<LiveInner>,
}

struct LiveInner {
    gate: FeedbackGate,
    /// Pages with an open comment draft.
    drafting: u32,
    /// `wait_for_feedback` calls and harness wake waits in progress.
    listeners: u32,
    /// User messages a harness hook already woke the agent for (see `wake`).
    told: std::collections::HashSet<diffd_core::model::MessageId>,
    last_agent: Option<Millis>,
    presence: Presence,
    snapshot: Arc<Snapshot>,
    fingerprint: u64,
    /// Read on first use; see [`history`].
    history: Option<History>,
    ranges: history::RangeCache,
    /// The repository root language servers see, for reviews of the working tree.
    code_root: Option<std::path::PathBuf>,
    /// Files outside the diff the page opened, so their diagnostics are kept too.
    context_paths: std::collections::HashSet<String>,
    /// Files outside the repository a language server pointed at; only these can be opened.
    external_paths: std::collections::HashSet<String>,
    diagnostics: std::collections::BTreeMap<String, Vec<diffd_core::model::Diagnostic>>,
}

impl App {
    pub async fn new(
        store: Store,
        repo: Arc<dyn RepoSource>,
        engine: Arc<dyn DiffEngine>,
        clock: Arc<dyn Clock>,
        base_url: String,
    ) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            store,
            repo,
            engine,
            clock,
            base_url,
            live: Mutex::new(HashMap::new()),
            watcher: Mutex::new(None),
            code: Mutex::new(None),
            waiters: Mutex::default(),
            prefetching: tokio::sync::Mutex::new(()),
            me: me.clone(),
        })
    }

    /// Register how reviews of the working tree follow edits (see `adapters::watch`).
    pub fn set_watcher(&self, watcher: Arc<dyn TreeWatch>) {
        *self.watcher.lock().expect("watcher lock") = Some(watcher);
    }

    /// Resume following the working tree for reviews touched lately (after a
    /// restart). Older ones resume when someone opens them.
    pub async fn resume_watches(&self) -> Result<()> {
        let since = self.now().saturating_sub(RESUME_WITHIN_MS);
        for (meta, _) in self.store.recent(200).await? {
            if meta.updated_at < since {
                break;
            }
            match self.store.review(&meta.id).await {
                Ok(Some((meta, spec))) if spec.watch && meta.to.is_none() => self.start_watch(&meta),
                Ok(_) => {}
                // One unreadable review mustn't keep the server from starting.
                Err(e) => tracing::warn!(review = %meta.id, error = %e, "can't resume watching"),
            }
        }
        Ok(())
    }

    fn start_watch(&self, meta: &ReviewMeta) {
        if let Some(w) = self.watcher.lock().expect("watcher lock").as_ref() {
            w.watch(&meta.id, std::path::Path::new(&meta.repo_path));
        }
    }

    pub fn url(&self, id: &ReviewId) -> String {
        format!("{}/r/{id}", self.base_url)
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    fn now(&self) -> Millis {
        self.clock.now()
    }

    /// Live state for a review, loading its latest snapshot on first use.
    pub(crate) async fn live(&self, id: &ReviewId) -> Result<Arc<Live>> {
        if let Some(l) = self.live.lock().expect("live lock").get(id) {
            return Ok(l.clone());
        }
        let snapshot = self.store.latest_snapshot(id).await?.ok_or_else(|| AppError::NotFound(format!("no review with id `{id}`")))?;
        // First use since a restart: a review of the working tree follows it again.
        if let Ok((meta, spec)) = self.meta(id).await
            && spec.watch
            && meta.to.is_none()
        {
            self.start_watch(&meta);
        }
        Ok(self.insert_live(id, snapshot, 0))
    }

    fn insert_live(&self, id: &ReviewId, snapshot: Snapshot, fingerprint: u64) -> Arc<Live> {
        let mut map = self.live.lock().expect("live lock");
        map.entry(id.clone())
            .or_insert_with(|| {
                Arc::new(Live {
                    tx: broadcast::channel(256).0,
                    feedback: Notify::new(),
                    rebuild: tokio::sync::Mutex::new(()),
                    deliver: tokio::sync::Mutex::new(()),
                    inner: Mutex::new(LiveInner {
                        gate: FeedbackGate::default(),
                        drafting: 0,
                        listeners: 0,
                        told: Default::default(),
                        last_agent: None,
                        presence: Presence::Away,
                        snapshot: Arc::new(snapshot),
                        fingerprint,
                        history: None,
                        ranges: history::RangeCache::default(),
                        code_root: None,
                        context_paths: Default::default(),
                        external_paths: Default::default(),
                        diagnostics: Default::default(),
                    }),
                })
            })
            .clone()
    }

    pub(crate) fn snapshot(live: &Live) -> Arc<Snapshot> {
        live.inner.lock().expect("live lock").snapshot.clone()
    }

    /// Subscribe to a review's page messages.
    pub async fn subscribe(&self, id: &ReviewId) -> Result<broadcast::Receiver<ServerMsg>> {
        Ok(self.live(id).await?.tx.subscribe())
    }

    /// Everything the page needs, as of now.
    pub async fn state(&self, id: &ReviewId) -> Result<ReviewState> {
        let live = self.live(id).await?;
        let (review, spec) = self.meta(id).await?;
        let (presence, diagnostics) = {
            let inner = live.inner.lock().expect("live lock");
            (inner.presence, inner.diagnostics.clone())
        };
        let history = self.history(&live, &review, &spec).await;
        Ok(ReviewState {
            review,
            snapshot: (*Self::snapshot(&live)).clone(),
            threads: self.store.threads(id).await?,
            regions: spec.regions,
            history,
            chat: self.store.chat(id).await?,
            activity: self.store.activity(id).await?,
            presence,
            read_seq: self.store.read_seq(id).await?,
            diagnostics,
        })
    }

    async fn meta(&self, id: &ReviewId) -> Result<(ReviewMeta, crate::adapters::store::ReviewSpec)> {
        self.store.review(id).await?.ok_or_else(|| AppError::NotFound(format!("no review with id `{id}`")))
    }

    fn broadcast(live: &Live, msg: ServerMsg) {
        // No subscribers is fine: nobody has the page open.
        let _ = live.tx.send(msg);
    }

    /// Recompute presence and tell pages if it changed.
    fn update_presence(&self, live: &Live) {
        let now = self.now();
        let changed = {
            let mut inner = live.inner.lock().expect("live lock");
            let presence = if inner.listeners > 0 {
                Presence::Listening
            } else if inner.last_agent.is_some_and(|t| now.saturating_sub(t) < AWAY_AFTER_MS) {
                Presence::Working
            } else {
                Presence::Away
            };
            let changed = presence != inner.presence;
            inner.presence = presence;
            changed.then_some(presence)
        };
        if let Some(presence) = changed {
            Self::broadcast(live, ServerMsg::Presence { presence });
        }
    }

    /// Note that the agent did something.
    fn agent_seen(&self, live: &Live) {
        live.inner.lock().expect("live lock").last_agent = Some(self.now());
        self.update_presence(live);
    }
}

/// Short random ids like `k3f9x2ab`, readable in URLs.
pub(crate) fn new_id(prefix: &str) -> String {
    const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    let mut id = String::from(prefix);
    for _ in 0..10 {
        id.push(ALPHABET[rand::random_range(0..ALPHABET.len())] as char);
    }
    id
}

impl App {
    /// Delete a review and everything said about it.
    pub async fn delete(&self, id: &ReviewId) -> Result<()> {
        self.meta(id).await?;
        self.store.delete_review(id).await?;
        if let Some(w) = self.watcher.lock().expect("watcher lock").as_ref() {
            w.unwatch(id);
        }
        let live = self.live.lock().expect("live lock").remove(id);
        // Open pages hear it now, even while something else still holds the review.
        if let Some(live) = live {
            Self::broadcast(&live, ServerMsg::Gone { message: "This review was deleted.".into() });
        }
        Ok(())
    }

    /// Recompute presence for every live review; call periodically so idle agents show as away.
    pub fn tick(&self) {
        let lives: Vec<Arc<Live>> = self.live.lock().expect("live lock").values().cloned().collect();
        for live in lives {
            self.update_presence(&live);
        }
    }
}
