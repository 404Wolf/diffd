//! Pushing feedback into the agent's Herdr inbox (`App::set_inbox`), with the
//! harness hooks (`App::wait_for_wake`) as the fallback: each message is
//! announced once, whichever path takes it, and a failed push falls back at once.

mod common;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use diffd_core::model::ReviewId;
use diffd_server::App;
use diffd_server::app::ShareRequest;
use diffd_server::ports::AgentInbox;
use futures::future::BoxFuture;
use tokio::sync::Semaphore;

/// A Herdr core as the pusher sees it. Its core-id reads and its sends can be
/// held at a gate, so a test decides which path looks first.
struct FakeInbox {
    core: Option<String>,
    accepts: AtomicBool,
    core_reads: AtomicUsize,
    sends: Mutex<Vec<(String, String, Instant)>>,
    core_gate: Arc<Semaphore>,
    send_gate: Arc<Semaphore>,
}

impl FakeInbox {
    fn new(core: Option<&str>) -> Arc<Self> {
        Arc::new(Self {
            core: core.map(str::to_owned),
            accepts: AtomicBool::new(true),
            core_reads: AtomicUsize::new(0),
            sends: Mutex::default(),
            core_gate: Arc::new(Semaphore::new(Semaphore::MAX_PERMITS)),
            send_gate: Arc::new(Semaphore::new(Semaphore::MAX_PERMITS)),
        })
    }

    /// Hold core-id reads (or sends) until [`open`] is called on the gate.
    fn closed(gate: &Arc<Semaphore>) {
        gate.forget_permits(Semaphore::MAX_PERMITS);
    }

    fn sends(&self) -> Vec<(String, String, Instant)> {
        self.sends.lock().unwrap().clone()
    }
}

fn open(gate: &Arc<Semaphore>) {
    gate.add_permits(1000);
}

impl AgentInbox for FakeInbox {
    fn core_id(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move {
            self.core_reads.fetch_add(1, Ordering::SeqCst);
            drop(self.core_gate.acquire().await.unwrap());
            self.core.clone()
        })
    }

    fn send<'a>(&'a self, terminal: &'a str, text: &'a str) -> BoxFuture<'a, bool> {
        Box::pin(async move {
            self.sends.lock().unwrap().push((terminal.to_owned(), text.to_owned(), Instant::now()));
            drop(self.send_gate.acquire().await.unwrap());
            self.accepts.load(Ordering::SeqCst)
        })
    }
}

/// A review shared by an agent in Herdr terminal `t5` of core `core-1`.
fn shared(repo: &common::Repo, route: Option<(&str, &str)>) -> ShareRequest {
    ShareRequest {
        repo_path: repo.path().to_string_lossy().into_owned(),
        from: "HEAD".into(),
        title: "Push me".into(),
        agent_terminal: route.map(|(t, _)| t.to_owned()),
        agent_core_id: route.map(|(_, c)| c.to_owned()),
        ..Default::default()
    }
}

async fn setup(inbox: &Arc<FakeInbox>, route: Option<(&str, &str)>) -> (common::Repo, Arc<App>, ReviewId) {
    let repo = common::Repo::new();
    repo.write("src/a.rs", "fn a() {}\n");
    repo.commit("init");
    repo.write("src/a.rs", "fn a() { b() }\n");
    let app = common::app().await;
    app.set_inbox(inbox.clone());
    let id = ReviewId(app.share(shared(&repo, route)).await.unwrap().review_id);
    (repo, app, id)
}

fn spawn_hook(app: &Arc<App>, repo: &common::Repo, waiter: &str, wait: Duration) -> tokio::task::JoinHandle<Option<String>> {
    let (app, cwd, waiter) = (app.clone(), repo.path(), waiter.to_owned());
    tokio::spawn(async move { app.wait_for_wake(&cwd, &waiter, wait).await.unwrap().map(|n| n.message) })
}

/// Waits up to `limit` for `done`, checking every 20 ms.
async fn until(limit: Duration, done: impl Fn() -> bool) -> bool {
    let end = Instant::now() + limit;
    while Instant::now() < end {
        if done() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    done()
}

#[tokio::test]
async fn feedback_reaches_the_inbox_within_seconds_and_once() {
    let inbox = FakeInbox::new(Some("core-1"));
    let (repo, app, id) = setup(&inbox, Some(("t5", "core-1"))).await;

    let started = Instant::now();
    app.chat_user(&id, None, "why call b here?").await.unwrap();
    assert!(until(Duration::from_secs(5), || !inbox.sends().is_empty()).await, "pushed");
    let (terminal, text, at) = inbox.sends()[0].clone();
    let took = at - started;
    assert!(took >= Duration::from_millis(1400), "it waits for the user to pause, like the hooks: {took:?}");
    assert!(took < Duration::from_millis(2500), "and goes out as soon as they have: {took:?}");
    assert_eq!(terminal, "t5", "the agent's own terminal");
    assert!(text.contains(&format!("review_id={}", id.0)) && text.contains("> why call b here?"), "{text}");

    // Nothing new: no second push, and a hook finds nothing either.
    tokio::time::sleep(Duration::from_millis(1800)).await;
    assert_eq!(inbox.sends().len(), 1);
    assert!(app.wait_for_wake(&repo.path(), "claude:s1", Duration::from_millis(1800)).await.unwrap().is_none());
    assert_eq!(app.pending_count(&id).await.unwrap(), 1, "told, not yet read: wait_for_feedback still hands it out");
}

/// The pusher marks before it sends: a hook waiter looking during the send skips it.
#[tokio::test]
async fn inbox_first_the_hook_waiter_skips_what_is_being_pushed() {
    let inbox = FakeInbox::new(Some("core-1"));
    FakeInbox::closed(&inbox.send_gate);
    let (repo, app, id) = setup(&inbox, Some(("t5", "core-1"))).await;

    app.chat_user(&id, None, "one thing").await.unwrap();
    assert!(until(Duration::from_secs(5), || inbox.sends().len() == 1).await, "the pusher took it");
    let hook = spawn_hook(&app, &repo, "claude:s1", Duration::from_millis(2000));
    tokio::time::sleep(Duration::from_millis(500)).await;
    open(&inbox.send_gate);
    assert!(hook.await.unwrap().is_none(), "the hook didn't announce it too");
    assert_eq!(inbox.sends().len(), 1);
}

/// A hook waiter that takes the feedback first is the one that announces it.
#[tokio::test]
async fn hook_first_the_pusher_finds_nothing_to_push() {
    let inbox = FakeInbox::new(Some("core-1"));
    let (repo, app, id) = setup(&inbox, Some(("t5", "core-1"))).await;
    // The pusher is held before it looks; the hook waiter is already waiting.
    FakeInbox::closed(&inbox.core_gate);
    let hook = spawn_hook(&app, &repo, "claude:s1", Duration::from_secs(10));
    tokio::time::sleep(Duration::from_millis(200)).await;

    app.chat_user(&id, None, "one thing").await.unwrap();
    let notice = tokio::time::timeout(Duration::from_secs(5), hook).await.expect("hook woken").unwrap();
    assert!(notice.is_some_and(|m| m.contains("> one thing")));
    open(&inbox.core_gate);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(inbox.sends().is_empty(), "already announced by the hook: {:?}", inbox.sends());
}

/// A push that fails un-marks the feedback and wakes the hook waiter, which delivers it at once.
#[tokio::test]
async fn a_failed_push_falls_back_to_the_hooks_at_once() {
    let inbox = FakeInbox::new(Some("core-1"));
    inbox.accepts.store(false, Ordering::SeqCst); // e.g. nothing follows t5's inbox
    FakeInbox::closed(&inbox.send_gate);
    let (repo, app, id) = setup(&inbox, Some(("t5", "core-1"))).await;

    app.chat_user(&id, None, "are you there?").await.unwrap();
    assert!(until(Duration::from_secs(5), || inbox.sends().len() == 1).await, "the pusher tried");
    let hook = spawn_hook(&app, &repo, "claude:s1", Duration::from_secs(10));
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!hook.is_finished(), "marked while the push is in flight");

    let failed = Instant::now();
    open(&inbox.send_gate);
    let notice = tokio::time::timeout(Duration::from_secs(5), hook).await.expect("hook woken").unwrap();
    assert!(failed.elapsed() < Duration::from_millis(1000), "at once, not at a rescan: {:?}", failed.elapsed());
    assert!(notice.is_some_and(|m| m.contains("> are you there?")));

    // Announced once: neither path again.
    assert!(app.wait_for_wake(&repo.path(), "claude:s1", Duration::from_millis(1500)).await.unwrap().is_none());
    assert_eq!(inbox.sends().len(), 1);
}

/// With no hook waiter, feedback a failed push un-marked waits for the next one.
#[tokio::test]
async fn a_failed_push_leaves_feedback_for_the_next_hook() {
    let inbox = FakeInbox::new(Some("core-1"));
    inbox.accepts.store(false, Ordering::SeqCst);
    let (repo, app, id) = setup(&inbox, Some(("t5", "core-1"))).await;
    app.chat_user(&id, None, "later is fine").await.unwrap();
    assert!(until(Duration::from_secs(5), || inbox.sends().len() == 1).await);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let notice = app.wait_for_wake(&repo.path(), "claude:s1", Duration::from_secs(3)).await.unwrap();
    assert!(notice.is_some_and(|n| n.message.contains("> later is fine")));
}

/// No route, or a route on another core: the pusher leaves it all to the hooks.
#[tokio::test]
async fn without_a_route_on_this_core_the_hooks_deliver() {
    for route in [None, Some(("t5", "core-old"))] {
        let inbox = FakeInbox::new(Some("core-1"));
        let (repo, app, id) = setup(&inbox, route).await;
        let hook = spawn_hook(&app, &repo, "claude:s1", Duration::from_secs(10));
        tokio::time::sleep(Duration::from_millis(100)).await;
        app.chat_user(&id, None, "via the hook").await.unwrap();
        let notice = tokio::time::timeout(Duration::from_secs(5), hook).await.expect("hook woken").unwrap();
        assert!(notice.is_some(), "{route:?}");
        assert!(inbox.sends().is_empty(), "{route:?}");
        if route.is_none() {
            assert_eq!(inbox.core_reads.load(Ordering::SeqCst), 0, "no route: hc isn't even asked");
        }
    }
    // No Herdr at all (no core answers): the same.
    let inbox = FakeInbox::new(None);
    let (repo, app, id) = setup(&inbox, Some(("t5", "core-1"))).await;
    let hook = spawn_hook(&app, &repo, "claude:s1", Duration::from_secs(10));
    tokio::time::sleep(Duration::from_millis(100)).await;
    app.chat_user(&id, None, "via the hook").await.unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(5), hook).await.expect("hook woken").unwrap().is_some());
    assert!(inbox.sends().is_empty());
}

/// An agent that moved to another terminal gets the feedback there.
#[tokio::test]
async fn the_route_follows_the_agent() {
    let inbox = FakeInbox::new(Some("core-1"));
    let (_repo, app, id) = setup(&inbox, None).await;
    app.agent_at(&id, "t9".into(), "core-1".into()).await.unwrap();
    assert_eq!(app.agent_terminal(&id).await.unwrap().as_deref(), Some("t9"));
    app.chat_user(&id, None, "over here").await.unwrap();
    assert!(until(Duration::from_secs(5), || inbox.sends().len() == 1).await);
    assert_eq!(inbox.sends()[0].0, "t9");
}

/// The pusher looks when feedback changes, never on a timer: an idle diffd
/// with routed reviews doesn't ask hc anything.
#[tokio::test]
async fn an_idle_pusher_doesnt_poll() {
    let inbox = FakeInbox::new(Some("core-1"));
    let (_repo, app, id) = setup(&inbox, Some(("t5", "core-1"))).await;
    // At most the first pass, which may have run after the share.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let first = inbox.core_reads.load(Ordering::SeqCst);
    assert!(first <= 1, "{first}");
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(inbox.core_reads.load(Ordering::SeqCst), first);
    app.chat_user(&id, None, "one").await.unwrap();
    assert!(until(Duration::from_secs(5), || inbox.sends().len() == 1).await);
    let reads = inbox.core_reads.load(Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(inbox.core_reads.load(Ordering::SeqCst), reads, "quiet again once it's pushed");
}
