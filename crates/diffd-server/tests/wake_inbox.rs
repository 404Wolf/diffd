//! Pushing feedback into the agent's Herdr inbox (`App::set_inbox`), with the
//! harness hooks (`App::wait_for_wake`) as the fallback. The inbox is
//! preferred: hooks stand down for a review the pusher can reach, even when
//! one is already waiting, and take it back only on a definite refusal or
//! when there is no usable route. Each notice is announced once.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use diffd_core::model::{Anchor, ReviewId, Side};
use diffd_server::App;
use diffd_server::adapters::http;
use diffd_server::app::ShareRequest;
use diffd_server::ports::{AgentInbox, InboxCore, Outgoing, Sent};
use futures::future::BoxFuture;
use rmcp::ServiceExt;
use rmcp::model::CallToolRequestParams;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use serde_json::{Value, json};
use tokio::sync::Semaphore;

/// What the modelled core does with the next send.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Next {
    /// Queues it and says so.
    Queue,
    /// Refuses it (nothing follows that inbox).
    Refuse,
    /// Queues it, but the answer is lost.
    QueueLoseAnswer,
    /// Never gets it (the request is lost).
    Lose,
}

/// A Herdr core as the pusher sees it, modelled on herdr-core:
/// - it queues a key once, and remembers it for `keys_kept` (a repeat then
///   answers queued without queuing again), then forgets it;
/// - a key first sent before what it remembers is refused as unvouched
///   (`key_forgotten`), so is a send meant for another core (`other_core`);
/// - a different core id is a different core: it has none of the old keys.
///
/// Its core reads and its sends can be held at a gate, so a test decides
/// when the pusher gets its answers; `script` decides what the next sends
/// do (then `Queue`).
struct FakeInbox {
    core: Mutex<Option<InboxCore>>,
    script: Mutex<std::collections::VecDeque<Next>>,
    core_reads: AtomicUsize,
    /// Every send: terminal, text, when.
    sends: Mutex<Vec<(String, String, Instant)>>,
    keys: Mutex<Vec<String>>,
    /// What each core queued: core id, key, when. The messages agents get.
    queued: Mutex<Vec<(String, String, Instant)>>,
    core_gate: Semaphore,
    send_gate: Semaphore,
}

const HOUR: Duration = Duration::from_secs(3600);

fn core(id: &str, keys_kept: Duration) -> Option<InboxCore> {
    Some(InboxCore { id: id.into(), queues: true, keys_kept })
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

const OPEN: usize = 1 << 20;

impl FakeInbox {
    /// Core `core-1`, which takes inbox-only messages and queues every send.
    fn new() -> Arc<Self> {
        Self::with_core(core("core-1", HOUR))
    }

    fn with_core(core: Option<InboxCore>) -> Arc<Self> {
        Arc::new(Self {
            core: Mutex::new(core),
            script: Mutex::default(),
            core_reads: AtomicUsize::new(0),
            sends: Mutex::default(),
            keys: Mutex::default(),
            queued: Mutex::default(),
            core_gate: Semaphore::new(OPEN),
            send_gate: Semaphore::new(OPEN),
        })
    }

    fn then(&self, next: &[Next]) {
        self.script.lock().unwrap().extend(next.iter().copied());
    }

    /// The keys queued, by any core.
    fn queued(&self) -> Vec<String> {
        self.queued.lock().unwrap().iter().map(|(_, key, _)| key.clone()).collect()
    }

    fn sends(&self) -> Vec<(String, String, Instant)> {
        self.sends.lock().unwrap().clone()
    }

    fn core_reads(&self) -> usize {
        self.core_reads.load(Ordering::SeqCst)
    }
}

/// Holds whoever waits at `gate` until [`open`].
fn close(gate: &Semaphore) {
    gate.forget_permits(OPEN);
}

fn open(gate: &Semaphore) {
    gate.add_permits(OPEN);
}

impl AgentInbox for FakeInbox {
    fn local_core(&self) -> BoxFuture<'_, Option<InboxCore>> {
        Box::pin(async move {
            self.core_reads.fetch_add(1, Ordering::SeqCst);
            drop(self.core_gate.acquire().await.unwrap());
            self.core.lock().unwrap().clone()
        })
    }

    fn send<'a>(&'a self, notice: &'a Outgoing) -> BoxFuture<'a, Sent> {
        Box::pin(async move {
            self.sends.lock().unwrap().push((notice.terminal.clone(), notice.text.clone(), Instant::now()));
            self.keys.lock().unwrap().push(notice.key.clone());
            drop(self.send_gate.acquire().await.unwrap());
            let next = self.script.lock().unwrap().pop_front().unwrap_or(Next::Queue);
            if next == Next::Lose {
                return Sent::Unknown; // the core never heard of it
            }
            let Some(here) = self.core.lock().unwrap().clone() else { return Sent::Unvouched };
            if notice.core != here.id {
                return Sent::Unvouched; // `other_core`
            }
            let mut queued = self.queued.lock().unwrap();
            let known = queued.iter().any(|(c, k, at)| *c == here.id && *k == notice.key && at.elapsed() <= here.keys_kept);
            if known {
                return Sent::Queued; // `repeated`: not queued again
            }
            if notice.since_ms + (here.keys_kept.as_millis() as u64) < epoch_ms() {
                return Sent::Unvouched; // `key_forgotten`
            }
            let queue = |queued: &mut Vec<(String, String, Instant)>| queued.push((here.id.clone(), notice.key.clone(), Instant::now()));
            match next {
                Next::Queue => {
                    queue(&mut queued);
                    Sent::Queued
                }
                Next::Refuse => Sent::Refused,
                Next::QueueLoseAnswer => {
                    queue(&mut queued);
                    Sent::Unknown
                }
                Next::Lose => unreachable!(),
            }
        })
    }
}

fn shared(repo: &common::Repo, title: &str, route: Option<(&str, &str)>) -> ShareRequest {
    ShareRequest {
        repo_path: repo.path().to_string_lossy().into_owned(),
        from: "HEAD".into(),
        title: title.into(),
        agent_terminal: route.map(|(t, _)| t.to_owned()),
        agent_core_id: route.map(|(_, c)| c.to_owned()),
        ..Default::default()
    }
}

fn repo() -> common::Repo {
    let repo = common::Repo::new();
    repo.write("src/a.rs", "fn a() {}\n");
    repo.commit("init");
    repo.write("src/a.rs", "fn a() { b() }\n");
    repo
}

/// The agent runs in Herdr terminal `t5` of core `core-1`.
const ROUTE: Option<(&str, &str)> = Some(("t5", "core-1"));

/// A review shared with `route`, the pusher on `inbox` (none: diffd without one).
async fn setup(inbox: Option<&Arc<FakeInbox>>, route: Option<(&str, &str)>) -> (common::Repo, Arc<App>, ReviewId) {
    let repo = repo();
    let app = common::app().await;
    if let Some(inbox) = inbox {
        app.set_inbox(inbox.clone());
    }
    let id = ReviewId(app.share(shared(&repo, "Push me", route)).await.unwrap().review_id);
    (repo, app, id)
}

fn spawn_hook(app: &Arc<App>, repo: &common::Repo, wait: Duration) -> tokio::task::JoinHandle<Option<String>> {
    let (app, cwd) = (app.clone(), repo.path());
    tokio::spawn(async move { app.wait_for_wake(&cwd, "claude:s1", wait).await.unwrap().map(|n| n.message) })
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

/// The point of it: with a hook already waiting (an idle Claude between
/// turns has one), the inbox still announces it, within the pause plus a
/// moment, and the hook stays quiet.
#[tokio::test]
async fn the_inbox_is_preferred_over_a_waiting_hook() {
    let inbox = FakeInbox::new();
    let (repo, app, id) = setup(Some(&inbox), ROUTE).await;
    let hook = spawn_hook(&app, &repo, Duration::from_secs(5));
    tokio::time::sleep(Duration::from_millis(200)).await;

    let started = Instant::now();
    app.chat_user(&id, None, "why call b here?").await.unwrap();
    assert!(until(Duration::from_secs(5), || !inbox.sends().is_empty()).await, "pushed");
    let (terminal, text, at) = inbox.sends()[0].clone();
    let took = at - started;
    assert!(took >= Duration::from_millis(1400), "it waits for the user to pause, like the hooks: {took:?}");
    assert!(took < Duration::from_millis(2500), "and goes out as soon as they have: {took:?}");
    assert_eq!(terminal, "t5", "the agent's own terminal");
    assert!(text.contains(&format!("review_id={}", id.0)) && text.contains("> why call b here?"), "{text}");

    assert!(hook.await.unwrap().is_none(), "the hook stood down");
    assert_eq!(inbox.sends().len(), 1, "once");
    assert_eq!(inbox.queued().len(), 1);
    assert_eq!(app.pending_count(&id).await.unwrap(), 1, "told, not yet read: wait_for_feedback still hands it out");
}

/// Hooks wait for the pusher's decision, however long its answers take.
#[tokio::test]
async fn hooks_wait_while_the_pusher_decides() {
    let inbox = FakeInbox::new();
    let (repo, app, id) = setup(Some(&inbox), ROUTE).await;
    let hook = spawn_hook(&app, &repo, Duration::from_secs(8));
    tokio::time::sleep(Duration::from_millis(200)).await;
    close(&inbox.core_gate);

    app.chat_user(&id, None, "one thing").await.unwrap();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert!(!hook.is_finished(), "past the pause, and the hook still stands down");
    assert!(inbox.sends().is_empty());
    open(&inbox.core_gate);
    assert!(until(Duration::from_secs(3), || inbox.sends().len() == 1).await, "the inbox announces it");
    assert!(hook.await.unwrap().is_none());
    assert_eq!(inbox.sends().len(), 1);
}

/// A definite refusal (nothing follows that inbox) hands it to the hooks at
/// once; the next feedback tries the inbox again.
#[tokio::test]
async fn a_refusal_falls_back_to_the_hooks_at_once() {
    let inbox = FakeInbox::new();
    inbox.then(&[Next::Refuse]);
    close(&inbox.send_gate);
    let (repo, app, id) = setup(Some(&inbox), ROUTE).await;
    let hook = spawn_hook(&app, &repo, Duration::from_secs(10));
    tokio::time::sleep(Duration::from_millis(200)).await;

    app.chat_user(&id, None, "are you there?").await.unwrap();
    assert!(until(Duration::from_secs(5), || inbox.sends().len() == 1).await, "the pusher tried");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!hook.is_finished(), "marked while the send is in flight");

    let refused = Instant::now();
    open(&inbox.send_gate);
    let notice = tokio::time::timeout(Duration::from_secs(5), hook).await.expect("hook woken").unwrap();
    assert!(refused.elapsed() < Duration::from_millis(1000), "at once, not at a rescan: {:?}", refused.elapsed());
    assert!(notice.is_some_and(|m| m.contains("> are you there?")));
    assert!(app.wait_for_wake(&repo.path(), "claude:s1", Duration::from_millis(1800)).await.unwrap().is_none(), "once");
    assert_eq!(inbox.sends().len(), 1);

    // The agent may follow its inbox again by now: new feedback tries it first.
    app.chat_user(&id, None, "and now?").await.unwrap();
    assert!(until(Duration::from_secs(5), || inbox.sends().len() == 2).await, "tried again");
    assert!(inbox.sends()[1].1.contains("> and now?"));
}

/// With no hook waiting, a refused notice waits for the next hook.
#[tokio::test]
async fn a_refused_notice_waits_for_the_next_hook() {
    let inbox = FakeInbox::new();
    inbox.then(&[Next::Refuse]);
    let (repo, app, id) = setup(Some(&inbox), ROUTE).await;
    app.chat_user(&id, None, "later is fine").await.unwrap();
    assert!(until(Duration::from_secs(5), || inbox.sends().len() == 1).await);
    tokio::time::sleep(Duration::from_millis(200)).await;
    let notice = app.wait_for_wake(&repo.path(), "claude:s1", Duration::from_secs(3)).await.unwrap();
    assert!(notice.is_some_and(|n| n.message.contains("> later is fine")));
}

/// No clear answer: the same notice is sent again under the same key until
/// the core says queued or refused. However the answers were lost, the agent
/// gets exactly one message, and the hooks never announce it too.
#[tokio::test]
async fn an_unclear_send_is_retried_under_its_key_until_settled() {
    let cases: [(&str, &[Next], usize); 4] = [
        ("queued, answer lost", &[Next::QueueLoseAnswer], 2),
        ("request lost", &[Next::Lose], 2),
        ("lost twice, then queued", &[Next::Lose, Next::QueueLoseAnswer], 3),
        ("queued, then the retry's answer lost too", &[Next::QueueLoseAnswer, Next::Lose], 3),
    ];
    for (case, script, sends) in cases {
        let inbox = FakeInbox::new();
        inbox.then(script);
        let (repo, app, id) = setup(Some(&inbox), ROUTE).await;
        let hook = spawn_hook(&app, &repo, Duration::from_secs(6));
        tokio::time::sleep(Duration::from_millis(100)).await;
        app.chat_user(&id, None, "did it go in?").await.unwrap();
        // Retries after 1 s, then 2 s.
        assert!(until(Duration::from_secs(8), || inbox.sends().len() == sends).await, "{case}: {:?}", inbox.sends());
        tokio::time::sleep(Duration::from_millis(300)).await;
        let keys = inbox.keys.lock().unwrap().clone();
        assert!(keys.iter().all(|k| *k == keys[0]), "{case}: one key for one notice: {keys:?}");
        assert_eq!(inbox.queued().len(), 1, "{case}: the agent gets it once");
        assert_eq!(inbox.sends().len(), sends, "{case}: settled, no more sends");
        assert!(hook.await.unwrap().is_none(), "{case}: no second notice from the hook");
    }
}

/// No clear answer, then a definite refusal (the core checks its keys
/// first, so it never queued it): the hooks announce it, once.
#[tokio::test]
async fn an_unclear_send_then_refused_goes_to_the_hooks() {
    let inbox = FakeInbox::new();
    inbox.then(&[Next::Lose, Next::Refuse]);
    let (repo, app, id) = setup(Some(&inbox), ROUTE).await;
    let hook = spawn_hook(&app, &repo, Duration::from_secs(10));
    tokio::time::sleep(Duration::from_millis(100)).await;
    app.chat_user(&id, None, "anyone?").await.unwrap();
    let notice = tokio::time::timeout(Duration::from_secs(6), hook).await.expect("hook woken").unwrap();
    assert!(notice.is_some_and(|m| m.contains("> anyone?")));
    assert_eq!(inbox.sends().len(), 2);
    assert!(inbox.queued().is_empty());
}

/// Every attempt lost (never queued anywhere): when the retry window is up,
/// the hooks announce it, once. The wake is at least once; losing it isn't
/// an option.
#[tokio::test]
async fn when_every_attempt_is_lost_the_hooks_announce_it_once() {
    // Keys kept 2.4 s: retries for 1.2 s, so after 1 s, not after 3 s.
    let inbox = FakeInbox::with_core(core("core-1", Duration::from_millis(2400)));
    inbox.then(&[Next::Lose, Next::Lose, Next::Lose]);
    let (repo, app, id) = setup(Some(&inbox), ROUTE).await;
    let hook = spawn_hook(&app, &repo, Duration::from_secs(8));
    tokio::time::sleep(Duration::from_millis(100)).await;
    app.chat_user(&id, None, "lost in transit").await.unwrap();
    let notice = tokio::time::timeout(Duration::from_secs(6), hook).await.expect("hook woken").unwrap();
    assert!(notice.is_some_and(|m| m.contains("> lost in transit")));
    assert_eq!(inbox.sends().len(), 2, "retried within the window, not after");
    assert!(inbox.queued().is_empty(), "never queued");
    assert!(app.wait_for_wake(&repo.path(), "claude:s1", Duration::from_millis(1800)).await.unwrap().is_none(), "announced once");
    tokio::time::sleep(Duration::from_millis(2000)).await;
    assert_eq!(inbox.sends().len(), 2, "no retry once the window is up");
}

/// The first attempt went in but its answer was lost, and every retry is
/// lost too: past the window the hooks announce it as well. Two notices at
/// most, and retries stop before the core forgets the key, so the inbox
/// itself never queues it twice.
#[tokio::test]
async fn an_unsettled_send_falls_to_the_hooks_at_the_end_of_the_window() {
    let inbox = FakeInbox::with_core(core("core-1", Duration::from_millis(2400)));
    inbox.then(&[Next::QueueLoseAnswer, Next::Lose, Next::Lose]);
    let (repo, app, id) = setup(Some(&inbox), ROUTE).await;
    let hook = spawn_hook(&app, &repo, Duration::from_secs(8));
    tokio::time::sleep(Duration::from_millis(100)).await;
    app.chat_user(&id, None, "maybe twice").await.unwrap();
    let notice = tokio::time::timeout(Duration::from_secs(6), hook).await.expect("hook woken").unwrap();
    assert!(notice.is_some_and(|m| m.contains("> maybe twice")));
    tokio::time::sleep(Duration::from_millis(3000)).await;
    assert_eq!(inbox.sends().len(), 2);
    assert_eq!(inbox.queued().len(), 1, "the inbox queued it once");
}

/// A retry goes to the core the notice was for, and no other: after a core
/// with another id took over (reusing the terminal address), the retry is
/// refused there and queues nothing; the hooks announce it.
#[tokio::test]
async fn a_retry_never_reaches_a_core_that_replaced_the_old_one() {
    for (case, first) in [("first attempt lost", Next::Lose), ("first attempt's answer lost", Next::QueueLoseAnswer)] {
        let inbox = FakeInbox::new();
        inbox.then(&[first]);
        close(&inbox.send_gate);
        let (repo, app, id) = setup(Some(&inbox), ROUTE).await;
        let hook = spawn_hook(&app, &repo, Duration::from_secs(8));
        tokio::time::sleep(Duration::from_millis(100)).await;
        app.chat_user(&id, None, "for the old agent").await.unwrap();
        assert!(until(Duration::from_secs(4), || inbox.sends().len() == 1).await, "{case}");
        open(&inbox.send_gate);
        tokio::time::sleep(Duration::from_millis(100)).await;
        *inbox.core.lock().unwrap() = core("core-2", HOUR);
        let notice = tokio::time::timeout(Duration::from_secs(4), hook).await.expect(case).unwrap();
        assert!(notice.is_some_and(|m| m.contains("> for the old agent")), "{case}");
        assert_eq!(inbox.sends().len(), 2, "{case}: retried once, refused by core-2");
        assert!(inbox.queued.lock().unwrap().iter().all(|(c, _, _)| c == "core-1"), "{case}: nothing on core-2");
        assert!(app.wait_for_wake(&repo.path(), "claude:s1", Duration::from_millis(1500)).await.unwrap().is_none(), "{case}");
    }
}

/// Refused outright by a core that took over before the first attempt: it
/// was never queued anywhere, so the hooks announce it.
#[tokio::test]
async fn a_first_send_to_a_replaced_core_goes_to_the_hooks() {
    let inbox = FakeInbox::new();
    close(&inbox.send_gate);
    let (repo, app, id) = setup(Some(&inbox), ROUTE).await;
    let hook = spawn_hook(&app, &repo, Duration::from_secs(10));
    tokio::time::sleep(Duration::from_millis(100)).await;
    app.chat_user(&id, None, "anyone?").await.unwrap();
    assert!(until(Duration::from_secs(4), || inbox.sends().len() == 1).await);
    *inbox.core.lock().unwrap() = core("core-2", HOUR);
    open(&inbox.send_gate);
    let notice = tokio::time::timeout(Duration::from_secs(3), hook).await.expect("hook woken").unwrap();
    assert!(notice.is_some_and(|m| m.contains("> anyone?")));
    assert!(inbox.queued().is_empty());
}

/// No route, a route on another core, no Herdr, a core that predates
/// inbox-only messages, or no pusher at all: the hooks deliver.
#[tokio::test]
async fn without_a_usable_route_the_hooks_deliver() {
    let new_core = || core("core-1", HOUR);
    let old_core = Some(InboxCore { id: "core-1".into(), queues: false, keys_kept: Duration::ZERO });
    // The case, the pusher (none, or the core it reads), the route.
    type Case = (&'static str, Option<Option<InboxCore>>, Option<(&'static str, &'static str)>);
    let cases: [Case; 5] = [
        ("no route", Some(new_core()), None),
        ("another core", Some(new_core()), Some(("t5", "core-old"))),
        ("no Herdr", Some(None), ROUTE),
        ("an old core", Some(old_core), ROUTE),
        ("no pusher", None, ROUTE),
    ];
    for (case, core, route) in cases {
        let inbox = core.map(FakeInbox::with_core);
        let (repo, app, id) = setup(inbox.as_ref(), route).await;
        let hook = spawn_hook(&app, &repo, Duration::from_secs(10));
        tokio::time::sleep(Duration::from_millis(100)).await;
        app.chat_user(&id, None, "via the hook").await.unwrap();
        let notice = tokio::time::timeout(Duration::from_secs(5), hook).await.expect(case).unwrap();
        assert!(notice.is_some(), "{case}");
        if let Some(inbox) = inbox {
            assert!(inbox.sends().is_empty(), "{case}");
            if route.is_none() {
                assert_eq!(inbox.core_reads(), 0, "no route: hc isn't even asked");
            }
        }
    }
}

/// Two reviews for one agent: one ready while the other is still held for
/// the pause. Both go out, each at its own pause, with nothing else happening.
#[tokio::test]
async fn feedback_still_held_goes_out_at_its_pause() {
    let inbox = FakeInbox::new();
    let repo = repo();
    let app = common::app().await;
    app.set_inbox(inbox.clone());
    let a = ReviewId(app.share(shared(&repo, "A", ROUTE)).await.unwrap().review_id);
    let b = ReviewId(app.share(shared(&repo, "B", ROUTE)).await.unwrap().review_id);

    let started = Instant::now();
    app.chat_user(&a, None, "on A").await.unwrap();
    tokio::time::sleep(Duration::from_millis(750)).await;
    app.chat_user(&b, None, "on B").await.unwrap();
    assert!(until(Duration::from_secs(5), || inbox.sends().len() == 2).await, "{:?}", inbox.sends());
    let sends = inbox.sends();
    assert!(sends[0].1.contains("> on A") && !sends[0].1.contains("> on B"), "{}", sends[0].1);
    assert!(sends[1].1.contains("> on B"), "{}", sends[1].1);
    let second = sends[1].2 - started;
    assert!(second >= Duration::from_millis(2150) && second < Duration::from_millis(3200), "B at its own pause: {second:?}");
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(inbox.sends().len(), 2, "once each");
}

/// The pusher looks when feedback changes, never on a timer: an idle diffd
/// with routed reviews doesn't ask hc anything.
#[tokio::test]
async fn an_idle_pusher_doesnt_poll() {
    let inbox = FakeInbox::new();
    let (_repo, app, id) = setup(Some(&inbox), ROUTE).await;
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(inbox.core_reads(), 0);
    app.chat_user(&id, None, "one").await.unwrap();
    assert!(until(Duration::from_secs(5), || inbox.sends().len() == 1).await);
    let reads = inbox.core_reads();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(inbox.core_reads(), reads, "quiet again once it's pushed");
}

// -- The route, over MCP ----------------------------------------------------

async fn serve(app: Arc<App>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let page = "<!doctype html><title>t</title><!--diffd-boot-->";
        axum::serve(listener, http::router(app, page, tokio_util::sync::CancellationToken::new())).await.unwrap();
    });
    format!("http://127.0.0.1:{port}")
}

/// An MCP client calling from Herdr terminal `terminal`.
async fn agent_in(base: &str, terminal: &'static str) -> rmcp::service::RunningService<rmcp::RoleClient, ()> {
    let headers = std::collections::HashMap::from([(
        axum::http::HeaderName::from_static("x-herdr-terminal"),
        axum::http::HeaderValue::from_static(terminal),
    )]);
    let config = StreamableHttpClientTransportConfig::with_uri(format!("{base}/mcp")).custom_headers(headers);
    ().serve(StreamableHttpClientTransport::from_config(config)).await.unwrap()
}

async fn call(client: &rmcp::Peer<rmcp::RoleClient>, tool: &'static str, args: Value) -> Value {
    let params = CallToolRequestParams::new(tool).with_arguments(args.as_object().unwrap().clone());
    let result = client.call_tool(params).await.unwrap();
    let text = serde_json::to_value(&result.content[0]).unwrap()["text"].as_str().unwrap().to_owned();
    assert_ne!(result.is_error, Some(true), "{tool} failed: {text}");
    serde_json::from_str(&text).unwrap_or(Value::String(text))
}

/// The route is the caller's own terminal and core, and every call the
/// agent answers with (reply, say, wait_for_feedback) brings it up to date:
/// an agent resumed in another terminal, or the same address on a restarted core.
#[tokio::test]
async fn the_route_follows_the_agent_over_mcp() {
    let inbox = FakeInbox::new();
    let app = common::app().await;
    app.set_inbox(inbox.clone());
    let base = serve(app.clone()).await;
    let repo = repo();

    let first = agent_in(&base, "tfirst").await;
    let shared = call(&first, "share_diff", json!({"repo_path": repo.path(), "from": "HEAD", "title": "routed"})).await;
    let id = ReviewId(shared["review_id"].as_str().unwrap().to_owned());
    assert_eq!(app.agent_route(&id).await.unwrap(), Some(("tfirst".into(), "core-1".into())));

    // Resumed in another terminal, answering a thread with reply.
    let anchor = Anchor { path: "src/a.rs".into(), side: Side::New, start: 1, end: 1, text: String::new(), range: None };
    let thread = app.comment(&id, None, anchor, "why?").await.unwrap();
    let moved = agent_in(&base, "tmoved").await;
    call(&moved, "reply", json!({"thread_id": thread.id.0, "body": "because"})).await;
    assert_eq!(app.agent_route(&id).await.unwrap(), Some(("tmoved".into(), "core-1".into())));

    // The same address on a restarted core, answering with say.
    *inbox.core.lock().unwrap() = core("core-2", HOUR);
    call(&moved, "say", json!({"review_id": id.0, "body": "still here"})).await;
    assert_eq!(app.agent_route(&id).await.unwrap(), Some(("tmoved".into(), "core-2".into())));

    // And wait_for_feedback; feedback then goes to the agent where it is now.
    let again = agent_in(&base, "tagain").await;
    call(&again, "wait_for_feedback", json!({"review_id": id.0, "timeout_seconds": 1})).await;
    assert_eq!(app.agent_route(&id).await.unwrap(), Some(("tagain".into(), "core-2".into())));
    app.chat_user(&id, None, "over here").await.unwrap();
    let arrived = || inbox.sends().iter().any(|(terminal, text, _)| terminal == "tagain" && text.contains("over here"));
    assert!(until(Duration::from_secs(5), arrived).await, "{:?}", inbox.sends());
    for client in [first, moved, again] {
        client.cancel().await.unwrap();
    }
}
