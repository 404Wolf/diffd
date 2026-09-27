//! Walking a review's commits: the history, diffs between any two points,
//! and comments written while looking at one commit.

mod common;

use std::sync::Arc;
use std::time::Duration;

use diffd_core::model::{Anchor, CommitRange, ReviewId, Side};
use diffd_server::app::ShareRequest;

fn request(repo: &common::Repo, from: &str, to: Option<&str>) -> ShareRequest {
    ShareRequest {
        repo_path: repo.path().to_string_lossy().into_owned(),
        from: from.into(),
        to: to.map(Into::into),
        merge_base: None,
        paths: vec![],
        title: "Three steps".into(),
        summary: None,
        annotations: vec![],
        collapse: vec![],
        regions: vec![],
        ..Default::default()
    }
}

/// `main` with one file, then a branch with three commits touching it.
fn repo() -> common::Repo {
    let repo = common::Repo::new();
    repo.write("a.txt", "one\n");
    repo.commit("init");
    repo.git(&["checkout", "-q", "-b", "feature"]);
    repo.write("a.txt", "one\ntwo\n");
    repo.commit("add two");
    repo.write("b.txt", "bee\n");
    repo.commit("add b");
    repo.write("a.txt", "one\ntwo\nthree\n");
    repo.commit("add three");
    repo
}

#[tokio::test]
async fn walks_commits_and_diffs_any_two() {
    let repo = repo();
    let app = common::app().await;
    let shared = app.share(request(&repo, "main", Some("feature"))).await.unwrap();
    let id = ReviewId(shared.review_id);

    let history = app.state(&id).await.unwrap().history;
    let subjects: Vec<&str> = history.commits.iter().map(|c| c.subject.as_str()).collect();
    assert_eq!(subjects, ["add two", "add b", "add three"]);
    assert!(!history.worktree && !history.truncated);
    let [c1, c2, c3] = [0, 1, 2].map(|i| history.commits[i].sha.clone());

    // One commit: just its own change.
    let one = app.range(&id, &c1, Some(c2.clone())).await.unwrap();
    assert_eq!(one.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["b.txt"]);
    // Two commits.
    let two = app.range(&id, &c1, Some(c3.clone())).await.unwrap();
    assert_eq!(two.files.len(), 2);
    let a = two.files.iter().find(|f| f.path == "a.txt").unwrap();
    assert_eq!((a.added, a.removed), (1, 0));
    // From the base.
    let first = app.range(&id, &history.base, Some(c1.clone())).await.unwrap();
    assert_eq!(first.files[0].new.as_ref().unwrap().lines, ["one", "two"]);

    // Only points in the history, in order.
    assert!(app.range(&id, &c3, Some(c1.clone())).await.is_err());
    assert!(app.range(&id, "HEAD~7", Some(c1.clone())).await.is_err());
    assert!(app.range(&id, &c1, None).await.is_err(), "this review doesn't end at the working tree");
}

#[tokio::test]
async fn comments_on_a_commit_find_their_place_in_the_whole_diff() {
    let repo = repo();
    let app = common::app().await;
    let shared = app.share(request(&repo, "main", Some("feature"))).await.unwrap();
    let id = ReviewId(shared.review_id);
    let history = app.state(&id).await.unwrap().history;
    let (base, c1, c3) = (history.base.clone(), history.commits[0].sha.clone(), history.commits[2].sha.clone());

    let range = Some(CommitRange { from: base, to: Some(c1.clone()) });
    let anchor = Anchor { path: "a.txt".into(), side: Side::New, start: 2, end: 2, text: "two".into(), range: range.clone() };
    let thread = app.comment(&id, None, anchor, "Why two?").await.unwrap();
    assert!(!thread.outdated);
    assert_eq!((thread.anchor.start, thread.anchor.text.as_str()), (2, "two"));

    // Code that no longer exists in the whole diff is kept, marked as such.
    let range = Some(CommitRange { from: c1, to: Some(c3) });
    let anchor = Anchor { path: "a.txt".into(), side: Side::New, start: 1, end: 1, text: "gone".into(), range };
    let thread = app.comment(&id, None, anchor, "What about this?").await.unwrap();
    assert!(thread.outdated);

    let batch = app.wait_for_feedback(&id, Duration::from_secs(5)).await.unwrap();
    let json = serde_json::to_value(&batch).unwrap();
    assert!(json["items"][0]["commented_on"].as_str().unwrap().contains(".."));
    assert_eq!(json["items"][1]["not_in_current_diff"], true);
}

#[tokio::test]
async fn new_commits_show_up_after_a_rebuild() {
    let repo = common::Repo::new();
    repo.write("a.txt", "one\n");
    repo.commit("init");
    repo.write("a.txt", "one\ntwo\n");
    let app = common::app().await;
    let shared = app.share(request(&repo, "HEAD", None)).await.unwrap();
    let id = ReviewId(shared.review_id);
    let history = app.state(&id).await.unwrap().history;
    assert!(history.commits.is_empty() && history.worktree);

    // Diffing against the tip of a review that includes the working tree.
    let uncommitted = app.range(&id, &history.base, None).await.unwrap();
    assert_eq!(uncommitted.files.len(), 1);

    // The agent commits. The review still starts where it was shared, so
    // the whole diff is unchanged, and the new commit joins the history.
    let mut rx = app.subscribe(&id).await.unwrap();
    repo.commit("add two");
    assert_eq!(app.rebuild(&id).await.unwrap(), None, "same whole diff");
    match rx.recv().await.unwrap() {
        diffd_core::protocol::ServerMsg::History { history } => {
            assert_eq!(history.commits.len(), 1);
            assert_eq!(history.commits[0].subject, "add two");
        }
        msg => panic!("expected the new history, got {msg:?}"),
    }
    assert_eq!(app.state(&id).await.unwrap().snapshot.files.len(), 1);
}

/// A diff engine that notes what it was asked to diff (each file's new side)
/// and leaves the diffing to the line diff.
#[derive(Default)]
struct Recording {
    diffed: std::sync::Mutex<Vec<String>>,
    /// Each diff takes this long, so tests can ask while one is in progress.
    delay: Duration,
}

impl diffd_server::ports::DiffEngine for Recording {
    fn diff(&self, _path: &str, _old: &str, new: &str) -> Option<diffd_core::difft::EngineDiff> {
        std::thread::sleep(self.delay);
        self.diffed.lock().unwrap().push(new.to_owned());
        None
    }
}

impl Recording {
    fn diffed(&self) -> Vec<String> {
        let mut d = self.diffed.lock().unwrap().clone();
        d.sort();
        d
    }

    /// Wait until `new` has been diffed.
    async fn wait_for(&self, new: &str) {
        for _ in 0..500 {
            if self.diffed.lock().unwrap().iter().any(|d| d == new) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("`{new:?}` was never diffed; diffed {:?}", self.diffed());
    }
}

/// `main`, then five commits that each change `a.txt`: its contents after
/// commit `i` are the lines `0..=i`.
fn five_commits() -> common::Repo {
    let repo = common::Repo::new();
    repo.write("a.txt", "0\n");
    repo.commit("init");
    repo.git(&["checkout", "-q", "-b", "feature"]);
    for i in 1..=5 {
        repo.write("a.txt", &after(i));
        repo.commit(&format!("commit {i}"));
    }
    repo
}

fn after(i: usize) -> String {
    (0..=i).map(|n| format!("{n}\n")).collect()
}

async fn app_with(engine: Arc<Recording>) -> Arc<diffd_server::App> {
    let store = diffd_server::adapters::store::Store::open("sqlite::memory:").await.unwrap();
    diffd_server::App::new(
        store,
        Arc::new(diffd_server::adapters::git::GitCli),
        engine,
        Arc::new(diffd_server::ports::SystemClock),
        "http://localhost:3433".into(),
    )
    .await
}

#[tokio::test]
async fn one_step_diffs_the_steps_around_it_ahead_of_time() {
    let repo = five_commits();
    let engine = Arc::new(Recording::default());
    let app = app_with(engine.clone()).await;
    let shared = app.share(request(&repo, "main", Some("feature"))).await.unwrap();
    let id = ReviewId(shared.review_id);
    let history = app.state(&id).await.unwrap().history;
    let points: Vec<String> = std::iter::once(history.base.clone()).chain(history.commits.iter().map(|c| c.sha.clone())).collect();
    engine.diffed.lock().unwrap().clear();

    // Step 2 (commit 3): steps 3, 1 and 4 follow in the background.
    let step = app.range(&id, &points[2], Some(points[3].clone())).await.unwrap();
    assert_eq!(step.files[0].new.as_ref().unwrap().lines.len(), 4);
    engine.wait_for(&after(5)).await;
    assert_eq!(engine.diffed(), [after(2), after(3), after(4), after(5)]);

    // Stepping to them diffs nothing new, except the next step back: step 0.
    for i in [3, 4] {
        app.range(&id, &points[i], Some(points[i + 1].clone())).await.unwrap();
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(engine.diffed(), [after(2), after(3), after(4), after(5)]);
    app.range(&id, &points[1], Some(points[2].clone())).await.unwrap();
    engine.wait_for(&after(1)).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(engine.diffed(), [after(1), after(2), after(3), after(4), after(5)]);

    // Ranges of several commits aren't walked, so nothing is diffed around them.
    engine.diffed.lock().unwrap().clear();
    app.range(&id, &points[0], Some(points[5].clone())).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(engine.diffed(), [after(5)]);
}

#[tokio::test]
async fn asking_again_while_a_range_is_diffed_waits_for_the_same_diff() {
    let repo = five_commits();
    let engine = Arc::new(Recording { delay: Duration::from_millis(200), ..Recording::default() });
    let app = app_with(engine.clone()).await;
    let shared = app.share(request(&repo, "main", Some("feature"))).await.unwrap();
    let id = ReviewId(shared.review_id);
    let history = app.state(&id).await.unwrap().history;
    let (from, to) = (history.commits[0].sha.clone(), history.commits[1].sha.clone());
    engine.diffed.lock().unwrap().clear();

    let (a, b) = tokio::join!(app.range(&id, &from, Some(to.clone())), app.range(&id, &from, Some(to.clone())));
    assert!(Arc::ptr_eq(&a.unwrap(), &b.unwrap()));
    assert_eq!(engine.diffed().iter().filter(|d| **d == after(2)).count(), 1);
}
