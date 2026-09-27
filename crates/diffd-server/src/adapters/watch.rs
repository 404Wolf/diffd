//! Rebuilding reviews of the working tree as files change.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use diffd_core::model::{ReviewId, ReviewMeta};
use notify::RecursiveMode;
use notify_debouncer_mini::{DebounceEventResult, Debouncer, new_debouncer};
use tokio::runtime::Handle;

use crate::app::App;

/// Directories whose churn never affects a review.
const IGNORED: &[&str] = &["/.git/objects/", "/.git/logs/", "/node_modules/", "/target/", "/.direnv/"];

/// Owns one debounced filesystem watcher per watched review.
#[derive(Default)]
pub struct Watcher {
    watchers: Mutex<HashMap<ReviewId, Debouncer<notify::RecommendedWatcher>>>,
}

impl Watcher {
    /// Hook this watcher into `app`, so shared reviews of the working tree follow edits.
    pub fn install(self: &Arc<Self>, app: &App, runtime: Handle) {
        let this = Arc::downgrade(self);
        app.set_watcher(move |app, meta| {
            if let Some(this) = this.upgrade() {
                this.watch(app, meta, runtime.clone());
            }
        });
    }

    fn watch(&self, app: Weak<App>, meta: &ReviewMeta, runtime: Handle) {
        let id = meta.id.clone();
        let root = PathBuf::from(&meta.repo_path);
        let review = id.clone();
        let handler = move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let relevant = events.iter().any(|e| {
                let p = e.path.to_string_lossy();
                !IGNORED.iter().any(|dir| p.contains(dir))
            });
            if !relevant {
                return;
            }
            let (app, review) = (app.clone(), review.clone());
            runtime.spawn(async move {
                let Some(app) = app.upgrade() else { return };
                match app.rebuild(&review).await {
                    Ok(Some(rev)) => tracing::info!(%review, rev, "review updated"),
                    Ok(None) => {}
                    Err(e) => tracing::warn!(%review, error = %e, "rebuild failed"),
                }
            });
        };
        let mut debouncer = match new_debouncer(Duration::from_millis(300), handler) {
            Ok(d) => d,
            Err(e) => return tracing::warn!(error = %e, "can't watch files; the review won't update live"),
        };
        if let Err(e) = debouncer.watcher().watch(&root, RecursiveMode::Recursive) {
            return tracing::warn!(error = %e, path = %root.display(), "can't watch the repository");
        }
        self.watchers.lock().expect("watch lock").insert(id, debouncer);
    }
}
