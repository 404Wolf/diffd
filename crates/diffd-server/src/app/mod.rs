//! Use cases. Everything the page or the agent can do goes through [`App`].

mod code;
mod context;
mod conversation;
mod feedback;
mod history;
mod push;
mod rebuild;
mod share;
mod wake;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use diffd_core::feedback::FeedbackGate;
use diffd_core::model::{History, Millis, Presence, ReviewId, ReviewMeta, Snapshot};
use diffd_core::protocol::{LiveState, ReviewState, ServerMsg};
use tokio::sync::{Notify, broadcast};

pub use code::{VIEW_GRACE, Viewing};
pub use conversation::{LayoutInput, NoteInput, RegionInput};
pub use feedback::{FeedbackBatch, FeedbackItem, ThreadMessage};
pub use history::RangeEnd;
pub use share::{ShareRequest, ShareResult};
pub use wake::{WakeNotice, WakeReview};

use crate::adapters::store::Store;
use crate::config::Limits;
use crate::ports::{AgentInbox, Clock, CodeIntel, DiffEngine, RepoSource, TreeWatch};

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

/// Reviews updated within this long are watched again right after a restart, and can wake agents.
const RECENT_MS: Millis = 7 * 24 * 60 * 60 * 1000;

/// What open pages are told when their review is deleted.
pub const DELETED_MESSAGE: &str = "This review was deleted.";

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
    /// Agents' Herdr inboxes, once [`App::set_inbox`] starts the pusher.
    inbox: Mutex<Option<Arc<dyn AgentInbox>>>,
    /// Whether the pusher runs: only then do reviews with a route wait for it.
    pushing: AtomicBool,
    /// Told when feedback changed anywhere: the pusher looks again (see `push`).
    pushes: Arc<Notify>,
    /// Held while diffing commits ahead of time (see `history`), so background
    /// work never takes more than one diff's worth of the machine.
    prefetching: tokio::sync::Mutex<()>,
    /// How much of the machine building diffs may take (see `rebuild`).
    limits: Limits,
    /// One permit per build allowed at once, across reviews.
    builds: Arc<tokio::sync::Semaphore>,
    /// The threads builds diff their files on.
    build_pool: Arc<rayon::ThreadPool>,
    /// Set by [`App::stop`]: builds give up instead of finishing.
    stopping: Arc<AtomicBool>,
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
    /// Pages showing the review. Language servers run for it only while there are some.
    viewers: u32,
    /// User messages the agent was already told about, by a harness hook
    /// (see `wake`) or in its Herdr inbox (see `push`): whichever takes a
    /// message first marks it here, so it's announced once.
    told: std::collections::HashSet<diffd_core::model::MessageId>,
    /// The agent's Herdr route (its terminal, that terminal's core), as in the spec.
    route: Option<(String, String)>,
    /// Who announces this review's feedback (see `push`). Changed only by
    /// [`LiveInner::set_delivery`].
    delivery: push::Delivery,
    /// Counts changes of `delivery`, so a pusher pass that looked before an
    /// await can tell its view went stale (see `push`).
    delivery_epoch: u64,
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
    /// The language servers for `code_root`, as last sent to pages.
    language_servers: Vec<diffd_core::model::LanguageServerStatus>,
}

impl App {
    pub fn new(store: Store, repo: Arc<dyn RepoSource>, engine: Arc<dyn DiffEngine>, clock: Arc<dyn Clock>, base_url: String) -> Arc<Self> {
        Self::with_limits(store, repo, engine, clock, base_url, Limits::default())
    }

    pub fn with_limits(
        store: Store,
        repo: Arc<dyn RepoSource>,
        engine: Arc<dyn DiffEngine>,
        clock: Arc<dyn Clock>,
        base_url: String,
        limits: Limits,
    ) -> Arc<Self> {
        let build_pool = rayon::ThreadPoolBuilder::new()
            .num_threads(limits.build_threads.max(1))
            .thread_name(|i| format!("diffd-build-{i}"))
            .build()
            .expect("starting the build threads");
        Arc::new_cyclic(|me| Self {
            builds: Arc::new(tokio::sync::Semaphore::new(limits.builds.max(1))),
            build_pool: Arc::new(build_pool),
            stopping: Arc::new(AtomicBool::new(false)),
            limits,
            store,
            repo,
            engine,
            clock,
            base_url,
            live: Mutex::new(HashMap::new()),
            watcher: Mutex::new(None),
            code: Mutex::new(None),
            waiters: Mutex::default(),
            inbox: Mutex::new(None),
            pushing: AtomicBool::new(false),
            pushes: Arc::new(Notify::new()),
            prefetching: tokio::sync::Mutex::new(()),
            me: me.clone(),
        })
    }

    /// diffd is stopping: builds in progress give up, and difftastic processes are killed.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.engine.stop();
        self.builds.close();
    }

    /// Register how reviews of the working tree follow edits (see `adapters::watch`).
    pub fn set_watcher(&self, watcher: Arc<dyn TreeWatch>) {
        *self.watcher.lock().expect("watcher lock") = Some(watcher);
    }

    /// Resume following the working tree for reviews touched lately (after a
    /// restart). Older ones resume when someone opens them.
    pub async fn resume_watches(&self) -> Result<()> {
        for meta in self.recent_reviews().await? {
            match self.store.review(&meta.id).await {
                Ok(Some((meta, spec))) if follows_worktree(&meta, &spec) => self.start_watch(&meta),
                Ok(_) => {}
                // One unreadable review mustn't keep the server from starting.
                Err(e) => tracing::warn!(review = %meta.id, error = %e, "can't resume watching"),
            }
        }
        Ok(())
    }

    /// Reviews updated within [`RECENT_MS`], newest first.
    async fn recent_reviews(&self) -> Result<Vec<ReviewMeta>> {
        let since = self.now().saturating_sub(RECENT_MS);
        Ok(self.store.reviews_since(since, 200).await?)
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
        let snapshot = self.store.latest_snapshot(id).await?.ok_or_else(|| no_review(id))?;
        let found = self.meta(id).await;
        // First use since a restart: a review of the working tree follows it again.
        if let Ok((meta, spec)) = &found
            && follows_worktree(meta, spec)
        {
            self.start_watch(meta);
        }
        let live = self.insert_live(id, Arc::new(snapshot), 0);
        if let Ok((_, spec)) = &found {
            live.inner.lock().expect("live lock").route = push::route_of(spec);
        }
        Ok(live)
    }

    fn insert_live(&self, id: &ReviewId, snapshot: Arc<Snapshot>, fingerprint: u64) -> Arc<Live> {
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
                        viewers: 0,
                        told: Default::default(),
                        route: None,
                        delivery: push::Delivery::Hooks,
                        delivery_epoch: 0,
                        last_agent: None,
                        presence: Presence::Away,
                        snapshot,
                        fingerprint,
                        history: None,
                        ranges: history::RangeCache::default(),
                        code_root: None,
                        context_paths: Default::default(),
                        external_paths: Default::default(),
                        diagnostics: Default::default(),
                        language_servers: Vec::new(),
                    }),
                })
            })
            .clone()
    }

    /// Every review in memory.
    fn lives(&self) -> Vec<Arc<Live>> {
        self.live.lock().expect("live lock").values().cloned().collect()
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
        let (snapshot, live) = self.live_state(id).await?;
        Ok(ReviewState::new((*snapshot).clone(), live))
    }

    /// The current snapshot, and everything else the page needs apart from it.
    pub async fn live_state(&self, id: &ReviewId) -> Result<(Arc<Snapshot>, LiveState)> {
        let live = self.live(id).await?;
        let (review, spec) = self.meta(id).await?;
        let (snapshot, presence, diagnostics, language_servers) = {
            let inner = live.inner.lock().expect("live lock");
            (inner.snapshot.clone(), inner.presence, inner.diagnostics.clone(), inner.language_servers.clone())
        };
        let history = self.history(&live, &review, &spec).await;
        let state = LiveState {
            review,
            threads: self.store.threads(id).await?,
            regions: spec.regions,
            layout: spec.layout,
            history,
            chat: self.store.chat(id).await?,
            activity: self.store.activity(id).await?,
            presence,
            read_seq: self.store.read_seq(id).await?,
            diagnostics,
            language_servers,
        };
        Ok((snapshot, state))
    }

    async fn meta(&self, id: &ReviewId) -> Result<(ReviewMeta, crate::adapters::store::ReviewSpec)> {
        self.store.review(id).await?.ok_or_else(|| no_review(id))
    }

    /// Repoint a review without rebuilding its diff or replacing its conversation/layout.
    /// Return the old metadata so the transport can repair the previous pane's label.
    pub async fn present(&self, id: &ReviewId, terminal: String, core_id: Option<String>) -> Result<ReviewMeta> {
        let live = self.live(id).await?;
        // Rebuild and annotate also write spec; don't let either overwrite this target.
        let _guard = live.rebuild.lock().await;
        let (meta, mut spec) = self.meta(id).await?;
        spec.terminal = Some(terminal);
        spec.core_id = core_id;
        self.store.set_spec(id, &spec).await?;
        self.store.touch_review(id, self.now()).await?;
        Ok(meta)
    }

    /// On a review the agent can be reached at in Herdr, the hooks stand down
    /// until the pusher decides (see `push`).
    fn to_pusher(&self, inner: &mut LiveInner) {
        if self.pushing.load(Ordering::SeqCst) && inner.route.is_some() && inner.delivery == push::Delivery::Hooks {
            inner.set_delivery(push::Delivery::Deciding);
        }
    }

    /// The user is about to write feedback on `live`: from now on, a hook
    /// waiter holds it for their pause and leaves a routed review to the
    /// pusher, so none sees the new feedback, once it's written, under the
    /// old rules. Keep the guard until it's written: dropping it tells
    /// everyone to look (see [`App::feedback_changed`]).
    fn user_activity<'a>(&'a self, live: &'a Live) -> FeedbackComing<'a> {
        {
            let mut inner = live.inner.lock().expect("live lock");
            inner.gate.touch(self.now());
            self.to_pusher(&mut inner);
        }
        FeedbackComing { app: self, live }
    }

    /// Feedback on `live` changed (a message, a pause, a draft opened or
    /// closed): hook waiters, waiting agents and the inbox pusher look again.
    fn feedback_changed(&self, live: &Live) {
        self.to_pusher(&mut live.inner.lock().expect("live lock"));
        live.feedback.notify_waiters();
        // A permit, kept if the pusher is busy: it looks again after.
        self.pushes.notify_one();
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

impl LiveInner {
    /// The one way `delivery` changes: each change starts a new epoch.
    fn set_delivery(&mut self, delivery: push::Delivery) {
        self.delivery = delivery;
        self.delivery_epoch += 1;
    }
}

/// See [`App::user_activity`].
struct FeedbackComing<'a> {
    app: &'a App,
    live: &'a Live,
}

impl Drop for FeedbackComing<'_> {
    fn drop(&mut self) {
        self.app.feedback_changed(self.live);
    }
}

fn no_review(id: &ReviewId) -> AppError {
    AppError::NotFound(format!("no review with id `{id}`"))
}

/// Whether a review follows the working tree as it changes.
fn follows_worktree(meta: &ReviewMeta, spec: &crate::adapters::store::ReviewSpec) -> bool {
    spec.watch && meta.to.is_none()
}

/// Whether either path is inside the other (or they're the same).
fn nested(a: &std::path::Path, b: &std::path::Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
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
            Self::broadcast(&live, ServerMsg::Gone { message: DELETED_MESSAGE.into() });
        }
        Ok(())
    }

    /// Recompute presence for every live review; call periodically so idle agents show as away.
    pub fn tick(&self) {
        for live in self.lives() {
            self.update_presence(&live);
        }
    }
}
