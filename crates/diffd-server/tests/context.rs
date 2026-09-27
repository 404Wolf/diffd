//! Files outside the diff: listing, opening, commenting and showing.

mod common;

use diffd_core::model::{Anchor, FileStatus, ReviewId, ShowRequest, Side};
use diffd_server::app::ShareRequest;

fn share(repo: &common::Repo) -> ShareRequest {
    ShareRequest {
        repo_path: repo.path().to_string_lossy().into_owned(),
        from: "HEAD".into(),
        to: None,
        merge_base: None,
        paths: vec![],
        title: "Context".into(),
        summary: None,
        annotations: vec![],
        collapse: vec![],
        regions: vec![],
    }
}

fn repo() -> common::Repo {
    let repo = common::Repo::new();
    repo.write("src/lib.rs", "pub mod util;\n");
    repo.write("src/util.rs", "pub fn helper() -> u32 {\n    42\n}\n");
    repo.write(".gitignore", "target/\n");
    repo.commit("init");
    repo.write("src/lib.rs", "pub mod util;\npub use util::helper;\n");
    repo.write("target/junk.txt", "ignored\n");
    repo
}

#[tokio::test]
async fn lists_and_opens_files_outside_the_diff() {
    let repo = repo();
    let app = common::app().await;
    let id = ReviewId(app.share(share(&repo)).await.unwrap().review_id);

    let files = app.repo_files(&id).await.unwrap();
    assert_eq!(files, ["src/lib.rs", "src/util.rs", ".gitignore"].map(String::from), "tree order (folders first), ignored files left out");

    let util = app.context_file(&id, "src/util.rs").await.unwrap();
    assert_eq!(util.status, FileStatus::Unchanged);
    assert_eq!(util.language.as_deref(), Some("Rust"));
    assert_eq!(util.new.as_ref().unwrap().lines[1], "    42");
    assert!(!util.new.as_ref().unwrap().syntax.is_empty(), "highlighted");
    assert_eq!((util.added, util.removed), (0, 0));

    for bad in ["../etc/passwd", "/etc/passwd", ".git/config", "src/../../x"] {
        assert!(app.context_file(&id, bad).await.is_err(), "{bad} must be refused");
    }
    assert!(app.context_file(&id, "src/missing.rs").await.is_err());
}

#[cfg(unix)]
#[tokio::test]
async fn symlinks_out_of_the_repository_are_not_followed() {
    let repo = repo();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret"), "nope").unwrap();
    std::os::unix::fs::symlink(outside.path().join("secret"), repo.dir.path().join("link")).unwrap();
    let app = common::app().await;
    let id = ReviewId(app.share(share(&repo)).await.unwrap().review_id);
    assert!(app.context_file(&id, "link").await.is_err());
}

#[tokio::test]
async fn comments_and_show_work_on_files_outside_the_diff() {
    let repo = repo();
    let app = common::app().await;
    let id = ReviewId(app.share(share(&repo)).await.unwrap().review_id);

    let anchor = Anchor { path: "src/util.rs".into(), side: Side::New, start: 2, end: 2, text: String::new(), range: None };
    let thread = app.comment(&id, None, anchor, "Why 42?").await.unwrap();
    assert_eq!(thread.anchor.text, "    42");
    assert!(!thread.outdated);

    // A rebuild of the diff leaves threads on other files alone.
    repo.write("src/lib.rs", "pub mod util;\npub use util::helper;\n// more\n");
    app.rebuild(&id).await.unwrap();
    let state = app.state(&id).await.unwrap();
    let t = state.threads.iter().find(|t| t.id == thread.id).unwrap();
    assert!(!t.outdated && t.anchor.start == 2);

    let show = ShowRequest { path: "src/util.rs".into(), side: Side::New, start: 1, end: 3, message: "The helper".into() };
    app.show(&id, show).await.unwrap();
    let bad = ShowRequest { path: "src/util.rs".into(), side: Side::New, start: 1, end: 30, message: String::new() };
    assert!(app.show(&id, bad).await.is_err(), "lines must exist");
}
