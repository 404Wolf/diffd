//! Walking a review's commits: the history, diffs between any two points,
//! and comments written while looking at one commit.

mod common;

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
