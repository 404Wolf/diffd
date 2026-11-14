//! The pusher's recovery and ordering, from inside the crate: these tests
//! break the database on purpose, or stop a write between its commit and its
//! announcement, which the public API can't.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use diffd_core::model::{Author, Message, MessageId, ReviewId};
use futures::future::BoxFuture;

use super::super::wake::{Look, Taker};
use super::super::{App, ShareRequest, new_id};
use crate::adapters::difft::NoEngine;
use crate::adapters::git::GitCli;
use crate::adapters::store::Store;
use crate::ports::{AgentInbox, InboxCore, Outgoing, Sent, SystemClock};

/// Core `core-1`, queuing everything.
#[derive(Default)]
struct Inbox {
    sends: Mutex<Vec<String>>,
}

impl AgentInbox for Inbox {
    fn local_core(&self) -> BoxFuture<'_, Option<InboxCore>> {
        Box::pin(async { Some(InboxCore { id: "core-1".into(), queues: true, keys_kept: Duration::from_secs(3600) }) })
    }

    fn send<'a>(&'a self, notice: &'a Outgoing) -> BoxFuture<'a, Sent> {
        Box::pin(async move {
            self.sends.lock().unwrap().push(notice.text.clone());
            Sent::Queued
        })
    }
}

fn git(dir: &Path, args: &[&str]) {
    assert!(Command::new("git").arg("-C").arg(dir).args(args).status().unwrap().success(), "git {args:?}");
}

/// A review shared by an agent in Herdr terminal `t5` of `core-1`, the pusher on.
async fn routed() -> (tempfile::TempDir, PathBuf, Arc<App>, Arc<Inbox>, ReviewId) {
    let inbox = Arc::new(Inbox::default());
    let (dir, path, app, id) = routed_with(inbox.clone()).await;
    (dir, path, app, inbox, id)
}

/// [`routed`], pushing to `inbox`.
async fn routed_with(inbox: Arc<dyn AgentInbox>) -> (tempfile::TempDir, PathBuf, Arc<App>, ReviewId) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().canonicalize().unwrap();
    git(&path, &["init", "-q", "-b", "main"]);
    git(&path, &["config", "user.email", "test@example.com"]);
    git(&path, &["config", "user.name", "Test"]);
    std::fs::write(path.join("a.rs"), "fn a() {}\n").unwrap();
    git(&path, &["add", "-A"]);
    git(&path, &["commit", "-q", "-m", "init"]);
    std::fs::write(path.join("a.rs"), "fn a() { b() }\n").unwrap();

    let store = Store::open("sqlite::memory:").await.unwrap();
    let app = App::new(store, Arc::new(GitCli), Arc::new(NoEngine), Arc::new(SystemClock), "http://localhost:3433".into());
    app.set_inbox(inbox);
    let req = ShareRequest {
        repo_path: path.to_string_lossy().into_owned(),
        from: "HEAD".into(),
        title: "Routed".into(),
        agent_terminal: Some("t5".into()),
        agent_core_id: Some("core-1".into()),
        ..Default::default()
    };
    let id = ReviewId(app.share(req).await.unwrap().review_id);
    (dir, path, app, id)
}

/// A pass that fails reading the database, before it claimed anything
/// (`messages`) or after it claimed a review's feedback (`reviews`, read for
/// the notice), hands the review to the hooks, which announce it once the
/// database is back.
#[tokio::test]
async fn a_pass_that_fails_hands_its_reviews_to_the_hooks() {
    for table in ["messages", "reviews"] {
        let (_dir, path, app, inbox, id) = routed().await;
        app.chat_user(&id, None, "first").await.unwrap();
        // While the pusher waits out the user's pause, the table goes away.
        sqlx::query(&format!("ALTER TABLE {table} RENAME TO away")).execute(app.store.pool()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(2000)).await;
        sqlx::query(&format!("ALTER TABLE away RENAME TO {table}")).execute(app.store.pool()).await.unwrap();
        assert!(inbox.sends.lock().unwrap().is_empty(), "{table}");
        let notice = app.wait_for_wake(&path, "claude:s1", Duration::from_secs(3)).await.unwrap();
        assert!(notice.is_some_and(|n| n.message.contains("> first")), "{table}: the hooks announce it");
    }
}

/// A hook waiter looking after a message is written, before its writer has
/// told anyone, sees it under the new rules: held for the pause, and left to
/// the pusher. Then the inbox announces it.
#[tokio::test]
async fn a_hook_looking_between_a_write_and_its_announcement_takes_nothing() {
    let (_dir, _path, app, inbox, id) = routed().await;
    let live = app.live(&id).await.unwrap();

    // The writer, stopped after its commit and before it tells anyone.
    let activity = app.user_activity(&live);
    let message =
        Message { id: MessageId(new_id("m")), author: Author::User, body: "between".into(), created_at: app.now(), delivered_at: None };
    assert!(app.store.insert_message(&id, None, &message).await.unwrap());
    let look = app.take_notice(&[(id.clone(), live.clone())], Taker::Hook).await.unwrap();
    assert!(!matches!(look, Look::Notice(..)), "a hook took routed feedback");

    // Past the pause the hook still takes nothing: the review is the pusher's.
    tokio::time::sleep(Duration::from_millis(1600)).await;
    let look = app.take_notice(&[(id.clone(), live.clone())], Taker::Hook).await.unwrap();
    assert!(!matches!(look, Look::Notice(..)), "a hook took routed feedback after the pause");

    let told = Instant::now();
    drop(activity);
    while inbox.sends.lock().unwrap().is_empty() {
        assert!(told.elapsed() < Duration::from_secs(5), "never pushed");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(inbox.sends.lock().unwrap()[0].contains("> between"));
}

/// Core `core-1`. The first send is refused once the test says so; the next
/// `local_core` after `hold_core` waits until the test says so.
#[derive(Default)]
struct Gated {
    sends: Mutex<Vec<String>>,
    send_held: tokio::sync::Notify,
    release_send: tokio::sync::Notify,
    hold_core: std::sync::atomic::AtomicBool,
    core_held: tokio::sync::Notify,
    release_core: tokio::sync::Notify,
}

impl AgentInbox for Gated {
    fn local_core(&self) -> BoxFuture<'_, Option<InboxCore>> {
        Box::pin(async {
            if self.hold_core.swap(false, std::sync::atomic::Ordering::SeqCst) {
                self.core_held.notify_one();
                self.release_core.notified().await;
            }
            Some(InboxCore { id: "core-1".into(), queues: true, keys_kept: Duration::from_secs(3600) })
        })
    }

    fn send<'a>(&'a self, notice: &'a Outgoing) -> BoxFuture<'a, Sent> {
        Box::pin(async move {
            let first = {
                let mut sends = self.sends.lock().unwrap();
                sends.push(notice.text.clone());
                sends.len() == 1
            };
            if !first {
                return Sent::Queued;
            }
            self.send_held.notify_one();
            self.release_send.notified().await;
            Sent::Refused
        })
    }
}

/// A pass that looked at a review before the inbox handed it to the hooks,
/// and resumes after, leaves it with the hooks: they announce everything,
/// and the stale pass takes nothing.
#[tokio::test]
async fn a_pass_that_resumes_after_a_handoff_leaves_the_review_to_the_hooks() {
    let inbox = Arc::new(Gated::default());
    let (_dir, path, app, id) = routed_with(inbox.clone()).await;
    let live = app.live(&id).await.unwrap();

    // The inbox takes the first message and its send waits.
    app.chat_user(&id, None, "first").await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), inbox.send_held.notified()).await.expect("never sent");

    // New feedback starts a pass, which notes the review (the inbox's) and waits on the core.
    inbox.hold_core.store(true, std::sync::atomic::Ordering::SeqCst);
    app.chat_user(&id, None, "second").await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), inbox.core_held.notified()).await.expect("no pass");

    // Meanwhile the core refuses the first send: the review goes to the hooks.
    inbox.release_send.notify_one();
    let handed = Instant::now();
    loop {
        {
            let inner = live.inner.lock().unwrap();
            if inner.delivery == super::Delivery::Hooks && inner.told.is_empty() {
                break;
            }
        }
        assert!(handed.elapsed() < Duration::from_secs(5), "never handed to the hooks");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    // The stale pass resumes; then a hook looks.
    inbox.release_core.notify_one();
    let notice = app.wait_for_wake(&path, "claude:s1", Duration::from_secs(5)).await.unwrap().expect("the hooks announce it");
    assert!(notice.message.contains("> first") && notice.message.contains("> second"), "{}", notice.message);
    assert_eq!(live.inner.lock().unwrap().delivery, super::Delivery::Hooks);
    assert_eq!(inbox.sends.lock().unwrap().len(), 1, "the stale pass took the review back for the inbox");
}
