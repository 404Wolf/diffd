//! Waking an agent that isn't listening (`App::wait_for_wake`, behind the
//! harness hooks): who gets woken, when, and only once per message.

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use diffd_core::model::{Presence, ReviewId};
use diffd_server::App;
use diffd_server::app::ShareRequest;

fn shared(repo: &common::Repo) -> ShareRequest {
    ShareRequest {
        repo_path: repo.path().to_string_lossy().into_owned(),
        from: "HEAD".into(),
        to: None,
        merge_base: None,
        paths: vec![],
        title: "Wake me".into(),
        summary: None,
        annotations: vec![],
        collapse: vec![],
        regions: vec![],
    }
}

async fn setup() -> (common::Repo, Arc<App>, ReviewId) {
    let repo = common::Repo::new();
    repo.write("src/a.rs", "fn a() {}\n");
    repo.commit("init");
    repo.write("src/a.rs", "fn a() { b() }\n");
    let app = common::app().await;
    let id = ReviewId(app.share(shared(&repo)).await.unwrap().review_id);
    (repo, app, id)
}

fn spawn_wait(app: &Arc<App>, cwd: std::path::PathBuf, waiter: &str, secs: u64) -> tokio::task::JoinHandle<Option<String>> {
    let (app, waiter) = (app.clone(), waiter.to_owned());
    tokio::spawn(async move { app.wait_for_wake(&cwd, &waiter, Duration::from_secs(secs)).await.unwrap().map(|n| n.message) })
}

#[tokio::test]
async fn feedback_wakes_the_agent_once_after_the_user_pauses() {
    let (repo, app, id) = setup().await;
    let waiting = spawn_wait(&app, repo.path().join("src"), "claude:s1", 10);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(app.state(&id).await.unwrap().presence, Presence::Listening, "the page shows the agent will hear it");

    let started = Instant::now();
    app.chat_user(&id, None, "why call b here?").await.unwrap();
    let message = waiting.await.unwrap().expect("woken");
    assert!(started.elapsed() >= Duration::from_millis(1400), "it waits for the user to pause");
    assert!(message.contains(&format!("review_id={}", id.0)), "{message}");
    assert!(message.contains("1 chat message") && message.contains("> why call b here?"), "{message}");

    // The same message doesn't wake anyone again.
    let again = app.wait_for_wake(&repo.path(), "claude:s1", Duration::from_millis(1800)).await.unwrap();
    assert!(again.is_none());
}

#[tokio::test]
async fn a_newer_wait_or_a_cancel_ends_the_old_one() {
    let (repo, app, _id) = setup().await;
    let first = spawn_wait(&app, repo.path(), "codex:t1", 30);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let second = spawn_wait(&app, repo.path(), "codex:t1", 30);
    let ended = tokio::time::timeout(Duration::from_secs(2), first).await.expect("replaced promptly").unwrap();
    assert!(ended.is_none());

    app.cancel_wake("codex:t1");
    let ended = tokio::time::timeout(Duration::from_secs(2), second).await.expect("cancelled promptly").unwrap();
    assert!(ended.is_none());
}

#[tokio::test]
async fn only_agents_in_that_repository_are_woken_and_drafts_hold_it() {
    let (repo, app, id) = setup().await;
    let elsewhere = tempfile::tempdir().unwrap();
    let other = spawn_wait(&app, elsewhere.path().to_owned(), "claude:other", 6);
    let mine = spawn_wait(&app, repo.path(), "claude:mine", 20);
    tokio::time::sleep(Duration::from_millis(100)).await;

    // An open draft holds the wake until it's closed.
    app.drafting(&id, true).await.unwrap();
    app.chat_user(&id, None, "first thought").await.unwrap();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert!(!mine.is_finished(), "not while the user is still writing");
    app.drafting(&id, false).await.unwrap();
    let message = tokio::time::timeout(Duration::from_secs(5), mine).await.expect("woken after the draft").unwrap();
    assert!(message.is_some());
    assert!(other.await.unwrap().is_none(), "an agent in another directory isn't woken");
}

#[tokio::test]
async fn feedback_isnt_lost_to_a_wait_the_agent_gave_up_on() {
    let (_repo, app, id) = setup().await;
    // The agent's wait is abandoned (its tool call timed out) while the user writes.
    let abandoned = {
        let (app, id) = (app.clone(), id.clone());
        tokio::spawn(async move { app.wait_for_feedback(&id, Duration::from_secs(30)).await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    app.chat_user(&id, None, "are you there?").await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    abandoned.abort();
    assert!(abandoned.await.unwrap_err().is_cancelled());
    // It's still there for the next wait, and a hook would still wake the agent for it.
    assert_eq!(app.pending_count(&id).await.unwrap(), 1);
    let batch = app.wait_for_feedback(&id, Duration::from_secs(5)).await.unwrap();
    assert_eq!(batch.items.len(), 1);
}
