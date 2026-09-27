//! Language servers follow the pages: nothing starts them while nobody views a
//! review, and they stop once the last page showing it closes.

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use diffd_core::model::{CodeAnswer, CodeQuery, ReviewId};
use diffd_server::app::ShareRequest;
use diffd_server::ports::{CodeIntel, FileDiagnostics};
use futures::FutureExt;
use futures::future::BoxFuture;
use tokio::sync::broadcast;

/// Records what diffd asks of its language servers.
#[derive(Default)]
struct Recorder {
    synced: Mutex<Vec<String>>,
    released: Mutex<Vec<PathBuf>>,
    diagnostics: Option<broadcast::Sender<FileDiagnostics>>,
}

impl CodeIntel for Recorder {
    fn sync<'a>(&'a self, _root: &'a Path, path: &'a str) -> BoxFuture<'a, ()> {
        self.synced.lock().unwrap().push(path.to_owned());
        async {}.boxed()
    }
    fn ask<'a>(&'a self, _: &'a Path, _: &'a str, _: CodeQuery, _: u32, _: u32) -> BoxFuture<'a, CodeAnswer> {
        async { CodeAnswer::Unavailable { reason: "fake".into() } }.boxed()
    }
    fn diagnostics(&self) -> broadcast::Receiver<FileDiagnostics> {
        self.diagnostics.as_ref().expect("a channel").subscribe()
    }
    fn release<'a>(&'a self, root: &'a Path) -> BoxFuture<'a, ()> {
        self.released.lock().unwrap().push(root.to_owned());
        async {}.boxed()
    }
}

fn recorder() -> Arc<Recorder> {
    Arc::new(Recorder { diagnostics: Some(broadcast::channel(16).0), ..Default::default() })
}

/// Syncs run in the background: wait until `ok` holds, or fail.
async fn eventually(what: &str, ok: impl Fn() -> bool) {
    for _ in 0..100 {
        if ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("never happened: {what}");
}

fn share(repo: &common::Repo, title: &str) -> ShareRequest {
    ShareRequest { repo_path: repo.path().to_string_lossy().into_owned(), from: "HEAD".into(), title: title.into(), ..Default::default() }
}

#[tokio::test]
async fn servers_run_only_while_a_page_views_the_review() {
    let repo = common::Repo::new();
    repo.write("src/lib.rs", "pub fn a() {}\n");
    repo.commit("init");
    repo.write("src/lib.rs", "pub fn a() -> u32 { 1 }\n");

    let app = common::app().await;
    let intel = recorder();
    app.set_code_intel(intel.clone());
    let id = ReviewId(app.share(share(&repo, "one")).await.unwrap().review_id);

    // The agent keeps working with nobody watching: no language server hears of it.
    repo.write("src/lib.rs", "pub fn a() -> u32 { 2 }\n");
    app.rebuild(&id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(intel.synced.lock().unwrap().is_empty(), "synced without a viewer");

    // A page opens the review: its files go to the language servers, and so do later changes.
    let viewing = app.view(&id).await.unwrap();
    eventually("the review's files synced", || intel.synced.lock().unwrap().iter().any(|p| p == "src/lib.rs")).await;
    repo.write("src/new.rs", "pub fn b() {}\n");
    app.rebuild(&id).await.unwrap();
    eventually("a new file synced", || intel.synced.lock().unwrap().iter().any(|p| p == "src/new.rs")).await;

    // The page closes: after the grace period, the repository's servers stop.
    std::mem::forget(viewing);
    app.unview(&id, Duration::ZERO).await;
    let root = repo.path().canonicalize().unwrap();
    assert_eq!(*intel.released.lock().unwrap(), vec![root]);

    // And changes no longer reach them.
    let before = intel.synced.lock().unwrap().len();
    repo.write("src/new.rs", "pub fn b() -> u8 { 0 }\n");
    app.rebuild(&id).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(intel.synced.lock().unwrap().len(), before, "synced after the last page closed");
}

#[tokio::test]
async fn a_reload_or_another_review_of_the_repository_keeps_them() {
    let repo = common::Repo::new();
    repo.write("src/lib.rs", "pub fn a() {}\n");
    repo.commit("init");
    repo.write("src/lib.rs", "pub fn a() -> u32 { 1 }\n");

    let app = common::app().await;
    let intel = recorder();
    app.set_code_intel(intel.clone());
    let one = ReviewId(app.share(share(&repo, "one")).await.unwrap().review_id);
    let two = ReviewId(app.share(ShareRequest { paths: vec!["src/lib.rs".into()], ..share(&repo, "two") }).await.unwrap().review_id);
    assert_ne!(one, two);

    // A page reloads: the new one connects before the grace period ends.
    let first = app.view(&one).await.unwrap();
    std::mem::forget(first);
    let unview = {
        let (app, one) = (app.clone(), one.clone());
        tokio::spawn(async move { app.unview(&one, Duration::from_millis(200)).await })
    };
    let reloaded = app.view(&one).await.unwrap();
    unview.await.unwrap();
    assert!(intel.released.lock().unwrap().is_empty(), "stopped across a reload");

    // Another review of the same repository is still open: its servers stay.
    let other = app.view(&two).await.unwrap();
    std::mem::forget(reloaded);
    app.unview(&one, Duration::ZERO).await;
    assert!(intel.released.lock().unwrap().is_empty(), "stopped while another review of the repository is viewed");

    // The last page closes.
    std::mem::forget(other);
    app.unview(&two, Duration::ZERO).await;
    assert_eq!(intel.released.lock().unwrap().len(), 1);
}
