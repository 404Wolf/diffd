//! Paths and files that trip up naive git plumbing.

mod common;

use diffd_core::model::{FileStatus, Omitted, ReviewId};
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
        ..Default::default()
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
    assert_eq!(big.omitted, Some(Omitted::TooLarge), "too large to diff, and not loaded");

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

#[tokio::test]
async fn changes_the_rows_cant_show_are_described() {
    let repo = common::Repo::new();
    repo.write("crlf.txt", "a\r\nb\r\n");
    repo.write("eol.txt", "a\nb\n");
    repo.write("space.rs", "fn main() { let x = 1; }\n");
    repo.write("run.sh", "echo hi\n");
    repo.write("prose.txt", "the quick brown fox\n");
    repo.commit("init");
    repo.write("crlf.txt", "a\nb\n");
    repo.write("eol.txt", "a\nb");
    repo.write("space.rs", "fn main() { let x =  1; }\n");
    repo.write("prose.txt", "the quick red fox\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(repo.dir.path().join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let app = common::app().await;
    let id = ReviewId(app.share(share(&repo, "HEAD")).await.unwrap().review_id);
    let snap = app.state(&id).await.unwrap().snapshot;
    let file = |p: &str| snap.files.iter().find(|f| f.path == p).unwrap_or_else(|| panic!("{p} missing"));

    assert_eq!(file("crlf.txt").details, ["line endings CRLF → LF"]);
    assert_eq!(file("eol.txt").details, ["no newline at end of file"]);
    #[cfg(unix)]
    assert_eq!(file("run.sh").details, ["mode 100644 → 100755"]);

    let space = file("space.rs");
    assert!(space.added == 1 && space.removed == 1, "a whitespace-only change still shows as a change");

    // Plain text gets word highlights, not the whole line.
    let prose = file("prose.txt");
    let novel = &prose.new.as_ref().unwrap().novel[0];
    assert_eq!(novel, &[10, 13], "only `red` is new");
}

#[tokio::test]
async fn a_repository_with_no_commits_can_be_shared() {
    let repo = common::Repo::new();
    repo.write("hello.txt", "hi\n");
    let app = common::app().await;
    let id = ReviewId(app.share(share(&repo, "HEAD")).await.unwrap().review_id);
    let state = app.state(&id).await.unwrap();
    assert_eq!(state.snapshot.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["hello.txt"]);
    assert!(state.history.commits.is_empty());

    // The first commit keeps the file in the review and lists the commit.
    repo.commit("first");
    app.rebuild(&id).await.unwrap();
    let state = app.state(&id).await.unwrap();
    assert_eq!(state.snapshot.files.len(), 1);
    assert_eq!(state.history.commits.len(), 1);
}

#[tokio::test]
async fn head_compares_directly_and_bad_titles_are_refused() {
    let repo = common::Repo::new();
    repo.write("a.txt", "one\n");
    repo.commit("one");
    repo.write("a.txt", "two\n");
    repo.commit("two");
    let app = common::app().await;

    // Backwards: HEAD isn't a branch, so this is the reverse diff, not an empty one.
    let mut back = share(&repo, "HEAD");
    back.to = Some("HEAD~1".into());
    let shared = app.share(back).await.unwrap();
    assert_eq!(shared.files, 1);

    let mut long = share(&repo, "HEAD~1");
    long.title = "x".repeat(10_000);
    assert!(app.share(long).await.unwrap_err().to_string().contains("summary"));
    let mut blank = share(&repo, "HEAD~1");
    blank.title = "  ".into();
    assert!(app.share(blank).await.is_err());
}

#[tokio::test]
async fn an_edited_file_after_a_rename_reads_from_disk() {
    // With rename detection git hashes working-tree files and prints ids that
    // were never stored: the new side has to come from the file itself.
    let repo = common::Repo::new();
    let body: String = (0..40).map(|i| format!("line {i}\n")).collect();
    repo.write("report.py", &body);
    repo.commit("init");
    repo.git(&["mv", "report.py", "logreport.py"]);
    repo.commit("rename");
    repo.write("logreport.py", "something else entirely\n");

    let app = common::app().await;
    let id = ReviewId(app.share(share(&repo, "HEAD~1")).await.unwrap().review_id);
    let snap = app.state(&id).await.unwrap().snapshot;
    let file = snap.files.iter().find(|f| f.path == "logreport.py").expect("in the diff");
    assert_eq!(file.new.as_ref().expect("a new side").lines, ["something else entirely"]);
}
