//! Waking an agent that isn't listening.
//!
//! `wait_for_feedback` only works while the agent is inside that tool call.
//! An interactive agent (Claude Code, Codex, …) ends its turn and waits for
//! its user, so comments left on the page would sit unread. Harness hooks
//! call [`App::wait_for_wake`] (through `GET /api/wake`) when a turn ends:
//! it returns once the user has left feedback on a review of that working
//! directory, and the hook wakes the agent, which then reads the feedback
//! with `wait_for_feedback` as usual.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use diffd_core::model::{Author, Millis, ReviewId};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use super::feedback::Listening;
use super::{App, Live, Result, nested};

/// How often a waiter looks for reviews shared after it started.
const RESCAN: Duration = Duration::from_secs(5);
/// How much of each message the wake notice quotes.
const PREVIEW_CHARS: usize = 160;
const PREVIEW_ITEMS: usize = 3;

/// What woke the agent, and what to tell it.
#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct WakeNotice {
    /// Addressed to the agent: what happened and what to do.
    pub message: String,
    pub reviews: Vec<WakeReview>,
}

#[derive(Debug, Clone, Serialize, Deserialize, utoipa::ToSchema)]
pub struct WakeReview {
    pub review_id: String,
    pub title: String,
    pub url: String,
    pub comments: usize,
    pub chat: usize,
}

/// The one waiter per harness session: a newer wait replaces an older one.
#[derive(Default)]
pub(super) struct Waiters {
    next: u64,
    by_key: HashMap<String, (u64, Arc<Notify>)>,
    /// When a hook last waited in each working directory: its agent can be woken.
    seen: HashMap<std::path::PathBuf, Millis>,
}

/// A hook seen this recently means its agent can end its turn and still hear the user.
const HOOKS_FRESH_MS: Millis = 24 * 60 * 60 * 1000;

/// Removes the waiter when the wait ends, unless a newer one took its place.
struct Registered<'a> {
    app: &'a App,
    key: String,
    generation: u64,
}

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        let mut waiters = self.app.waiters.lock().expect("waiters lock");
        if waiters.by_key.get(&self.key).is_some_and(|(g, _)| *g == self.generation) {
            waiters.by_key.remove(&self.key);
        }
    }
}

impl App {
    /// Wait until the user leaves feedback the agent hasn't been told about,
    /// on a review of the repository at (or around) `cwd`. `waiter`
    /// names the harness session: a new wait under the same name ends the
    /// old one (`None`), as does [`App::cancel_wake`]. `None` on timeout too.
    pub async fn wait_for_wake(&self, cwd: &Path, waiter: &str, timeout: Duration) -> Result<Option<WakeNotice>> {
        let cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_owned());
        let cancelled = Arc::new(Notify::new());
        let generation = {
            let mut waiters = self.waiters.lock().expect("waiters lock");
            waiters.seen.insert(cwd.clone(), self.now());
            waiters.next += 1;
            let generation = waiters.next;
            if let Some((_, old)) = waiters.by_key.insert(waiter.to_owned(), (generation, cancelled.clone())) {
                old.notify_one();
            }
            generation
        };
        let _registered = Registered { app: self, key: waiter.to_owned(), generation };
        let deadline = tokio::time::Instant::now() + timeout;
        let cancel = cancelled.notified();
        tokio::pin!(cancel);
        cancel.as_mut().enable();

        // Count as listening meanwhile: the page shows the agent will hear it. Held
        // across passes of the loop (a pass ends every few seconds), so pages
        // don't see the agent stop and start listening each time.
        let mut listening: HashMap<ReviewId, Listening<'_>> = HashMap::new();
        loop {
            let lives = self.reviews_around(&cwd).await?;
            listening.retain(|id, _| lives.iter().any(|(l, _)| l == id));
            for (id, live) in &lives {
                listening.entry(id.clone()).or_insert_with(|| Listening::start(self, live));
            }
            // Register for wake-ups before looking, so nothing slips between.
            let mut wakes: Vec<_> = lives.iter().map(|(_, live)| Box::pin(live.feedback.notified())).collect();
            for w in &mut wakes {
                w.as_mut().enable();
            }
            if let Some(notice) = self.take_notice(&lives).await? {
                return Ok(Some(notice));
            }
            let recheck = lives.iter().map(|(_, live)| self.gate_wait(live)).min().unwrap_or(RESCAN).min(RESCAN);
            let until = (tokio::time::Instant::now() + recheck).min(deadline);
            let any_feedback = async move {
                if wakes.is_empty() {
                    std::future::pending::<()>().await;
                } else {
                    futures::future::select_all(wakes).await;
                }
            };
            tokio::select! {
                () = &mut cancel => return Ok(None),
                _ = any_feedback => {}
                () = tokio::time::sleep_until(until) => {}
            }
            if tokio::time::Instant::now() >= deadline {
                return Ok(None);
            }
        }
    }

    /// Whether an agent working on the repository at `repo_path` has hooks
    /// that wake it (one waited lately), so it needn't sit in `wait_for_feedback`.
    pub(super) fn hooks_active(&self, repo_path: &Path) -> bool {
        let since = self.now().saturating_sub(HOOKS_FRESH_MS);
        let waiters = self.waiters.lock().expect("waiters lock");
        waiters.seen.iter().any(|(cwd, at)| *at >= since && nested(cwd, repo_path))
    }

    /// End the wait of `waiter`, if any (its session ended).
    pub fn cancel_wake(&self, waiter: &str) {
        if let Some((_, cancel)) = self.waiters.lock().expect("waiters lock").by_key.remove(waiter) {
            cancel.notify_one();
        }
    }

    /// Recently touched reviews of the repository containing `cwd`, or of repositories inside it.
    async fn reviews_around(&self, cwd: &Path) -> Result<Vec<(ReviewId, Arc<Live>)>> {
        let mut out = Vec::new();
        for meta in self.recent_reviews().await? {
            if nested(cwd, Path::new(&meta.repo_path)) {
                out.push((meta.id.clone(), self.live(&meta.id).await?));
            }
        }
        Ok(out)
    }

    /// How long until a review's feedback could be ready (the quiet period after typing).
    fn gate_wait(&self, live: &Live) -> Duration {
        Duration::from_millis(live.inner.lock().expect("live lock").gate.wait_ms(self.now()).max(100))
    }

    /// Feedback nobody was told about yet, if the user has paused; marks it told.
    async fn take_notice(&self, lives: &[(ReviewId, Arc<Live>)]) -> Result<Option<WakeNotice>> {
        let now = self.now();
        let mut reviews = Vec::new();
        let mut previews = Vec::new();
        for (id, live) in lives {
            let pending = self.store.undelivered(id).await?;
            let fresh: Vec<_> = {
                let mut inner = live.inner.lock().expect("live lock");
                if !inner.gate.ready(now) {
                    continue;
                }
                let fresh: Vec<_> = pending.into_iter().filter(|p| !inner.told.contains(&p.message.id)).collect();
                inner.told.extend(fresh.iter().map(|p| p.message.id.clone()));
                fresh
            };
            if fresh.is_empty() {
                continue;
            }
            let (meta, _) = self.meta(id).await?;
            let comments = fresh.iter().filter(|p| p.thread_id.is_some()).count();
            previews.extend(fresh.iter().filter(|p| p.message.author == Author::User).map(|p| quote(&p.message.body)).take(PREVIEW_ITEMS));
            reviews.push(WakeReview {
                review_id: id.0.clone(),
                title: meta.title,
                url: self.url(id),
                comments,
                chat: fresh.len() - comments,
            });
        }
        if reviews.is_empty() {
            return Ok(None);
        }
        Ok(Some(WakeNotice { message: notice_text(&reviews, &previews), reviews }))
    }
}

fn quote(body: &str) -> String {
    let line = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() > PREVIEW_CHARS { format!("{}…", line.chars().take(PREVIEW_CHARS).collect::<String>()) } else { line }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// The message the woken agent reads.
fn notice_text(reviews: &[WakeReview], previews: &[String]) -> String {
    let mut text = String::from("New feedback on your diffd review");
    if reviews.len() > 1 {
        text.push('s');
    }
    text.push_str(":\n");
    for r in reviews {
        let mut what = Vec::new();
        if r.comments > 0 {
            what.push(plural(r.comments, "comment", "comments"));
        }
        if r.chat > 0 {
            what.push(plural(r.chat, "chat message", "chat messages"));
        }
        text.push_str(&format!("- \"{}\" (review_id={}): {} · {}\n", r.title, r.review_id, what.join(", "), r.url));
    }
    for p in previews {
        text.push_str(&format!("  > {p}\n"));
    }
    text.push_str(
        "Call wait_for_feedback with that review_id to read it, answer each comment with reply (in its thread) \
         and chat messages with say.",
    );
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_notice_says_what_to_do() {
        let reviews = vec![WakeReview {
            review_id: "abc".into(),
            title: "Add limiter".into(),
            url: "http://localhost:3433/r/abc".into(),
            comments: 2,
            chat: 1,
        }];
        let text = notice_text(&reviews, &[quote("why\n  this?")]);
        assert!(text.contains("review_id=abc"));
        assert!(text.contains("2 comments, 1 chat message"));
        assert!(text.contains("> why this?"));
        assert!(text.contains("wait_for_feedback"));
        assert_eq!(quote(&"x".repeat(500)).chars().count(), PREVIEW_CHARS + 1);
    }
}
