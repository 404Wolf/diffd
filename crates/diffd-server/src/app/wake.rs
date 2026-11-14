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

use diffd_core::model::{Author, MessageId, Millis, ReviewId};
use serde::{Deserialize, Serialize};
use tokio::sync::Notify;

use super::feedback::Listening;
use super::push::Delivery;
use super::{App, Live, Result, nested};

/// How often a waiter looks for reviews shared after it started. Otherwise it
/// looks only when told something happened, or when feedback it's holding
/// back for the user's pause could go out.
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
    /// How many times waiters have looked for feedback, for [`App::wake_looks`].
    looks: u64,
}

/// Who is looking for feedback to announce. Each review's feedback is
/// announced by one of them at a time (its [`Delivery`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Taker {
    /// A harness hook's waiter (`wait_for_wake`).
    Hook,
    /// The Herdr inbox pusher (see `push`).
    Inbox,
}

impl Taker {
    fn takes(self, delivery: Delivery) -> bool {
        matches!((self, delivery), (Taker::Hook, Delivery::Hooks) | (Taker::Inbox, Delivery::Inbox))
    }
}

/// What a waiter found when it looked.
pub(super) enum Look {
    /// Feedback to wake the agent for, the messages now marked told, and how
    /// long other feedback it looked at is still held for the user's pause.
    Notice(WakeNotice, Vec<Told>, Option<Duration>),
    /// Feedback held back until the user pauses: look again after this long.
    Held(Duration),
    /// Nothing new (or only feedback behind an open draft, whose closing wakes the waiter).
    Nothing,
}

/// Messages of one review marked told for a notice: un-marked again if the
/// notice couldn't be sent (see [`App::untell`]).
pub(super) struct Told {
    live: Arc<Live>,
    ids: Vec<MessageId>,
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
            // Look again only when held feedback could go out, or to find new reviews:
            // a settled review has nothing to wait for, so it mustn't make the waiter
            // poll (it once did, ten times a second per waiter, ~170% CPU on SQLite).
            self.waiters.lock().expect("waiters lock").looks += 1;
            let recheck = match self.take_notice(&lives, Taker::Hook).await? {
                Look::Notice(notice, _, _) => return Ok(Some(notice)),
                Look::Held(wait) => wait.min(RESCAN),
                Look::Nothing => RESCAN,
            };
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

    /// How many times wake waiters have looked for feedback since start: each
    /// look reads the database, so an idle waiter should look rarely.
    #[doc(hidden)]
    pub fn wake_looks(&self) -> u64 {
        self.waiters.lock().expect("waiters lock").looks
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

    /// Feedback nobody was told about yet, if the user has paused; marks it told.
    /// Otherwise, how long until feedback held back for the pause could go out.
    /// Hook waiters and the inbox pusher both take feedback here, each only
    /// from reviews whose [`Delivery`] is theirs, and the `told` set, checked
    /// and marked under the review's lock, gives each message to one of them.
    pub(super) async fn take_notice(&self, lives: &[(ReviewId, Arc<Live>)], taker: Taker) -> Result<Look> {
        let mut taken = Taken::default();
        let result = self.take_fresh(lives, taker, &mut taken).await;
        let Taken { reviews, previews, told, held } = taken;
        if let Err(e) = result {
            // Marked but never announced: leave it for the next look.
            self.untell(told);
            return Err(e);
        }
        if reviews.is_empty() {
            return Ok(held.map_or(Look::Nothing, Look::Held));
        }
        Ok(Look::Notice(WakeNotice { message: notice_text(&reviews, &previews), reviews }, told, held))
    }

    /// [`App::take_notice`]'s work, gathered in `taken` as it goes, so a
    /// failure part way can un-mark what it marked.
    async fn take_fresh(&self, lives: &[(ReviewId, Arc<Live>)], taker: Taker, taken: &mut Taken) -> Result<()> {
        let now = self.now();
        for (id, live) in lives {
            if !taker.takes(live.inner.lock().expect("live lock").delivery) {
                continue;
            }
            let pending = self.store.undelivered(id).await?;
            let fresh: Vec<_> = {
                let mut inner = live.inner.lock().expect("live lock");
                // Changed hands while the store answered.
                if !taker.takes(inner.delivery) {
                    continue;
                }
                let fresh: Vec<_> = pending.into_iter().filter(|p| !inner.told.contains(&p.message.id)).collect();
                if fresh.is_empty() {
                    continue;
                }
                if !inner.gate.ready(now) {
                    // An open draft wakes the waiter when it closes; a pause just takes time.
                    if !inner.gate.drafting() {
                        let wait = Duration::from_millis(inner.gate.wait_ms(now).max(100));
                        taken.held = Some(taken.held.map_or(wait, |h| h.min(wait)));
                    }
                    continue;
                }
                inner.told.extend(fresh.iter().map(|p| p.message.id.clone()));
                fresh
            };
            taken.told.push(Told { live: live.clone(), ids: fresh.iter().map(|p| p.message.id.clone()).collect() });
            let (meta, _) = self.meta(id).await?;
            let comments = fresh.iter().filter(|p| p.thread_id.is_some()).count();
            let users = fresh.iter().filter(|p| p.message.author == Author::User);
            taken.previews.extend(users.map(|p| quote(&p.message.body)).take(PREVIEW_ITEMS));
            taken.reviews.push(WakeReview {
                review_id: id.0.clone(),
                title: meta.title,
                url: self.url(id),
                comments,
                chat: fresh.len() - comments,
            });
        }
        Ok(())
    }

    /// Un-marks messages taken for a notice that was never announced, and
    /// wakes the hook waiters to look again.
    pub(super) fn untell(&self, told: Vec<Told>) {
        for Told { live, ids } in told {
            {
                let mut inner = live.inner.lock().expect("live lock");
                for id in &ids {
                    inner.told.remove(id);
                }
            }
            live.feedback.notify_waiters();
        }
    }

    /// The inbox won't announce a notice: its reviews go back to the hooks,
    /// which announce its messages at once. Each review changes hands and
    /// un-marks its messages in one step under its lock, so nobody sees it
    /// the hooks' with its messages still marked told.
    pub(super) fn hand_to_hooks(&self, told: Vec<Told>) {
        for Told { live, ids } in told {
            {
                let mut inner = live.inner.lock().expect("live lock");
                inner.set_delivery(Delivery::Hooks);
                for id in &ids {
                    inner.told.remove(id);
                }
            }
            live.feedback.notify_waiters();
        }
    }
}

/// What [`App::take_fresh`] gathered.
#[derive(Default)]
struct Taken {
    reviews: Vec<WakeReview>,
    previews: Vec<String>,
    told: Vec<Told>,
    held: Option<Duration>,
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
