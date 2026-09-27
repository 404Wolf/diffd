//! Paths and files that trip up naive git plumbing.

mod common;

use diffd_core::model::{FileStatus, ReviewId};
use diffd_server::app::ShareRequest;

fn share(repo: &common::Repo, from: &str) -> ShareRequest {
    ShareRequest {
        repo_path: repo.path().to_string_lossy().into_owned(),
        from: from.into(),
        to: None,
        merge_base: None,
        paths: vec![],
        title: "edges".into(),
        summary: None,
        annotations: vec![],
        collapse: vec![],
        regions: vec![],
    }
}

#[tokio::test]
async fn odd_paths_symlinks_and_big_files() {
    let repo = common::Repo::new();
    repo.write("nl\nname.txt", "one\n");
    repo.write("x y.txt", "a\n");
    repo.write("big.txt", "small\n");
    repo.commit("init");
    repo.write("nl\nname.txt", "one\ntwo\n");
    repo.write("x y.txt", "a\nb\n");
    repo.write("big.txt", &"x".repeat(4 * 1024 * 1024));
    #[cfg(unix)]
    {
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), "do not show").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret"), repo.dir.path().join("link")).unwrap();
        // Keep the temp dir alive until the end of the test.
        std::mem::forget(outside);
    }

    let app = common::app().await;
    let id = ReviewId(app.share(share(&repo, "HEAD")).await.unwrap().review_id);
    let snap = app.state(&id).await.unwrap().snapshot;
    let file = |p: &str| {
        snap.files
            .iter()
            .find(|f| f.path == p)
            .unwrap_or_else(|| panic!("{p} missing: {:?}", snap.files.iter().map(|f| &f.path).collect::<Vec<_>>()))
    };

    let nl = file("nl\nname.txt");
    assert_eq!(nl.status, FileStatus::Modified);
    assert_eq!(nl.old.as_ref().unwrap().lines, ["one"]);
    assert_eq!(nl.new.as_ref().unwrap().lines, ["one", "two"]);
    assert_eq!(file("x y.txt").old.as_ref().unwrap().lines, ["a"], "the file after a newline path isn't shifted");

    let big = file("big.txt");
    assert!(big.binary && big.collapsed.is_some(), "too large to diff, and not loaded");

    #[cfg(unix)]
    {
        let link = file("link");
        let text = link.new.as_ref().unwrap().lines.join("\n");
        assert!(text.ends_with("/secret") && !text.contains("do not show"), "a symlink shows where it points, not what's there: {text}");
    }

    // Context files with odd names work at a fixed revision too.
    let mut fixed = share(&repo, "HEAD~0");
    fixed.to = Some("HEAD".into());
    let id = ReviewId(app.share(fixed).await.unwrap().review_id);
    assert!(app.context_file(&id, "no such.txt").await.is_err());
    assert_eq!(app.context_file(&id, "x y.txt").await.unwrap().new.unwrap().lines, ["a"]);
}
