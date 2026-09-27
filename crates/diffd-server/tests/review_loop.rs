//! The whole review loop against a real git repository: share, comment,
//! wait for feedback, reply, edit, rebuild.

mod common;

use std::time::Duration;

use diffd_core::model::{Anchor, Author, Side, ThreadKind};
use diffd_server::app::{NoteInput, ShareRequest};

const BEFORE: &str = "use std::time::Duration;\n\nfn timeout() -> Duration {\n    Duration::from_secs(1)\n}\n";
const AFTER: &str =
    "use std::time::Duration;\n\n/// How long to wait.\nfn timeout() -> Duration {\n    Duration::from_secs(1).max(QUIET)\n}\n";

fn share_request(repo: &common::Repo) -> ShareRequest {
    ShareRequest {
        repo_path: repo.path().to_string_lossy().into_owned(),
        from: "HEAD".into(),
        to: None,
        merge_base: None,
        paths: vec![],
        title: "Clamp the timeout".into(),
        summary: Some("Never wait less than the quiet period.".into()),
        annotations: vec![NoteInput {
            file: "src/lib.rs".into(),
            lines: [5, 5],
            side: None,
            body: "Clamped so a batch can always settle.".into(),
            kind: None,
        }],
        collapse: vec![diffd_server::adapters::store::CollapseRule { glob: "gen/**".into(), reason: "generated".into() }],
        regions: vec![],
    }
}

#[tokio::test]
async fn share_comment_wait_reply_rebuild() {
    let repo = common::Repo::new();
    repo.write("src/lib.rs", BEFORE);
    repo.write("gen/types.ts", "export type A = 1;\n");
    repo.commit("init");
    repo.write("src/lib.rs", AFTER);
    repo.write("gen/types.ts", "export type A = 2;\n");
    repo.write("src/new.rs", "pub fn added() {}\n");

    let app = common::app().await;
    let shared = app.share(share_request(&repo)).await.unwrap();
    assert_eq!(shared.files, 3, "modified, generated, and an untracked file");
    assert_eq!(shared.collapsed, vec!["gen/types.ts".to_owned()]);
    assert!(shared.url.ends_with(&format!("/r/{}", shared.review_id)));

    let id = diffd_core::model::ReviewId(shared.review_id.clone());
    let state = app.state(&id).await.unwrap();
    let lib = state.snapshot.files.iter().find(|f| f.path == "src/lib.rs").unwrap();
    assert_eq!(lib.language.as_deref(), Some("Rust"));
    assert!(lib.added >= 2, "doc comment and changed call");
    assert!(state.snapshot.symbols.iter().any(|s| s.name == "timeout"));
    let note = state.threads.iter().find(|t| matches!(t.kind, ThreadKind::Note { .. })).unwrap();
    assert_eq!(note.anchor.text, "    Duration::from_secs(1).max(QUIET)");

    // Nothing to hear yet: the wait times out empty.
    let batch = app.wait_for_feedback(&id, Duration::from_millis(50)).await.unwrap();
    assert!(batch.items.is_empty());

    // The agent waits while the user comments; the batch arrives after the quiet period.
    let waiter = {
        let (app, id) = (app.clone(), id.clone());
        tokio::spawn(async move { app.wait_for_feedback(&id, Duration::from_secs(10)).await.unwrap() })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    let anchor = Anchor { path: "src/lib.rs".into(), side: Side::New, start: 4, end: 5, text: String::new(), range: None };
    let thread = app.comment(&id, None, anchor, "Why clamp here and not at the call site?").await.unwrap();
    app.chat_user(&id, None, "Also: is QUIET defined yet?").await.unwrap();
    let batch = waiter.await.unwrap();
    assert_eq!(batch.items.len(), 2, "{batch:#?}");
    let json = serde_json::to_value(&batch).unwrap();
    assert_eq!(json["items"][0]["type"], "thread");
    assert_eq!(json["items"][0]["lines"], serde_json::json!([4, 5]));
    assert!(json["items"][0]["context"].as_str().unwrap().contains(">     5 |"));
    assert_eq!(json["items"][1]["type"], "chat");
    // Delivered messages aren't delivered twice.
    assert!(app.wait_for_feedback(&id, Duration::from_millis(50)).await.unwrap().items.is_empty());

    let replied = app.reply(&thread.id, None, Author::Agent, "Every caller needs it, so it lives here.", None).await.unwrap();
    assert_eq!(replied.messages.len(), 2);
    let delivered = app.state(&id).await.unwrap();
    let t = delivered.threads.iter().find(|t| t.id == thread.id).unwrap();
    assert!(t.messages[0].delivered_at.is_some());

    // Unchanged files: no new revision.
    assert_eq!(app.rebuild(&id).await.unwrap(), None);

    // Insert lines above the thread: it moves with its code. Change the note's line: it's marked.
    repo.write("src/lib.rs", &format!("// header\n// more\n{}", AFTER.replace(".max(QUIET)", ".max(QUIET_PERIOD)")));
    let rev = app.rebuild(&id).await.unwrap();
    assert_eq!(rev, Some(2));
    let state = app.state(&id).await.unwrap();
    assert_eq!(state.review.revision, 2);
    let lib = state.snapshot.files.iter().find(|f| f.path == "src/lib.rs").unwrap();
    assert_eq!(lib.since, vec![1, 2, 7]);
    let t = state.threads.iter().find(|t| t.id == thread.id).unwrap();
    assert!(t.changed_in.is_some(), "line 5 changed: {t:?}");
    let note = state.threads.iter().find(|t| matches!(t.kind, ThreadKind::Note { .. })).unwrap();
    assert_eq!((note.anchor.start, note.changed_in), (7, Some(2)));
    assert!(state.activity.iter().any(|a| matches!(a.kind, diffd_core::model::ActivityKind::Revision { revision: 2, .. })));
}

#[tokio::test]
async fn open_drafts_hold_feedback_back() {
    let repo = common::Repo::new();
    repo.write("a.txt", "one\n");
    repo.commit("init");
    repo.write("a.txt", "two\n");
    let app = common::app().await;
    let mut req = share_request(&repo);
    req.annotations.clear();
    let id = diffd_core::model::ReviewId(app.share(req).await.unwrap().review_id);

    app.drafting(&id, true).await.unwrap();
    app.chat_user(&id, None, "first").await.unwrap();
    let held = app.wait_for_feedback(&id, Duration::from_millis(2000)).await.unwrap();
    assert!(held.items.is_empty(), "a draft is open");
    app.drafting(&id, false).await.unwrap();
    let batch = app.wait_for_feedback(&id, Duration::from_secs(5)).await.unwrap();
    assert_eq!(batch.items.len(), 1);
}

#[tokio::test]
async fn bad_requests_explain_themselves() {
    let repo = common::Repo::new();
    repo.write("a.txt", "one\n");
    repo.commit("init");
    repo.write("a.txt", "two\n");
    let app = common::app().await;
    let mut req = share_request(&repo);
    let err = app.share(req.clone()).await.unwrap_err().to_string();
    assert!(err.contains("`src/lib.rs` is not in this diff"), "{err}");
    req.annotations.clear();
    req.from = "no-such-branch".into();
    let err = app.share(req).await.unwrap_err().to_string();
    assert!(err.contains("unknown revision"), "{err}");
}

#[tokio::test]
async fn working_tree_reviews_follow_edits() {
    let repo = common::Repo::new();
    repo.write("a.txt", "one\n");
    repo.commit("init");
    repo.write("a.txt", "two\n");
    let app = common::app().await;
    let watcher = std::sync::Arc::new(diffd_server::adapters::watch::Watcher::default());
    watcher.install(&app, tokio::runtime::Handle::current());
    let mut req = share_request(&repo);
    req.annotations.clear();
    let id = diffd_core::model::ReviewId(app.share(req).await.unwrap().review_id);
    let mut events = app.subscribe(&id).await.unwrap();

    repo.write("a.txt", "three\n");
    let got = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let diffd_core::protocol::ServerMsg::Revision { snapshot, .. } = events.recv().await.unwrap() {
                return snapshot;
            }
        }
    })
    .await
    .expect("no revision after editing a watched file");
    assert_eq!(got.revision, 2);
    assert_eq!(got.files[0].new.as_ref().unwrap().lines, vec!["three"]);
    assert_eq!(got.files[0].since, vec![1]);
}

#[tokio::test]
async fn a_bad_share_or_annotate_saves_nothing() {
    let repo = common::Repo::new();
    repo.write("src/lib.rs", BEFORE);
    repo.commit("init");
    repo.write("src/lib.rs", AFTER);
    let app = common::app().await;

    let mut req = share_request(&repo);
    req.annotations[0].lines = [50, 60];
    assert!(app.share(req).await.is_err());
    assert!(app.store().recent(10).await.unwrap().is_empty(), "no half-made review");

    let id = diffd_core::model::ReviewId(app.share(share_request(&repo)).await.unwrap().review_id);
    let before = app.state(&id).await.unwrap().threads.len();
    let good = NoteInput { file: "src/lib.rs".into(), lines: [1, 1], side: None, body: "fine".into(), kind: None };
    let bad_region = diffd_server::app::RegionInput {
        file: "nope.rs".into(),
        lines: None,
        side: None,
        kind: diffd_core::model::RegionKind::Test,
        summary: None,
    };
    assert!(app.annotate(&id, vec![good], vec![bad_region]).await.is_err());
    assert_eq!(app.state(&id).await.unwrap().threads.len(), before, "the good note wasn't saved either");
}
