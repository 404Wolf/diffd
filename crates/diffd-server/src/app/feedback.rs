//! Handing the user's comments to a waiting agent.

use std::time::Duration;

use diffd_core::model::{Author, MessageId, ReviewId, Side, Snapshot, Thread, ThreadId};
use diffd_core::protocol::ServerMsg;
use schemars::JsonSchema;
use serde::Serialize;

use super::{App, Live, Result};
use crate::adapters::store::Pending;

/// Lines of context shown around a thread's code.
const CONTEXT_LINES: usize = 3;

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct FeedbackBatch {
    pub review_id: String,
    pub url: String,
    /// New comments and chat messages, oldest first. Empty when the wait timed out.
    pub items: Vec<FeedbackItem>,
    pub next_step: String,
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FeedbackItem {
    /// New messages in a thread anchored to code.
    Thread {
        thread_id: String,
        path: String,
        side: String,
        /// First and last line, 1-based, in that side's file.
        lines: [u32; 2],
        /// The exact code the thread is about.
        code: String,
        /// The code with a few lines around it; anchored lines are marked with `>`.
        context: String,
        /// Earlier messages, for context.
        earlier: Vec<ThreadMessage>,
        /// What the user just wrote.
        new: Vec<String>,
        /// The code changed after the thread started.
        code_changed_since_comment: bool,
        /// Set when the user commented while looking at part of the history:
        /// `<from>..<to>` commits (`to` may be `working tree`). `path`, `side` and
        /// `lines` then point into the whole diff when the same code is still there.
        #[serde(skip_serializing_if = "Option::is_none")]
        commented_on: Option<String>,
        /// The commented code is no longer in the whole diff (it only existed in that part of the history).
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        not_in_current_diff: bool,
    },
    /// A message in the chat box, not tied to lines.
    Chat { message_id: String, body: String },
}

#[derive(Debug, Clone, Serialize, JsonSchema)]
pub struct ThreadMessage {
    pub author: String,
    pub body: String,
}

impl App {
    /// Wait until the user leaves feedback (and pauses), or `timeout` passes.
    pub async fn wait_for_feedback(&self, id: &ReviewId, timeout: Duration) -> Result<FeedbackBatch> {
        let live = self.live(id).await?;
        let outcome = {
            // Stop counting as a listener however this ends, including when the
            // client cancels the call and this future is dropped.
            let _listening = Listening::start(self, &live);
            self.wait_for_pending(id, &live, timeout).await?
        };
        let Some((pending, _deliver)) = outcome else {
            return Ok(FeedbackBatch {
                review_id: id.0.clone(),
                url: self.url(id),
                items: Vec::new(),
                next_step: if self.hooks_active_for(id).await {
                    "No feedback yet. You don't need to keep waiting: diffd wakes you when the user writes, so carry on \
                     or end your turn."
                        .into()
                } else {
                    "No feedback yet. Call wait_for_feedback again to keep listening, or carry on working.".into()
                },
            });
        };
        self.deliver(id, &live, &pending).await
    }

    /// Wait for undelivered feedback once the user pauses; `None` at `timeout`. Holds the
    /// review's deliver lock while returning it, so no other wait takes the same messages.
    async fn wait_for_pending<'a>(
        &self,
        id: &ReviewId,
        live: &'a Live,
        timeout: Duration,
    ) -> Result<Option<(Vec<Pending>, tokio::sync::MutexGuard<'a, ()>)>> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let notified = live.feedback.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let pending = self.store.undelivered(id).await?;
            let now = self.now();
            let (ready, wait) = {
                let inner = live.inner.lock().expect("live lock");
                let ready = !pending.is_empty() && inner.gate.ready(now);
                // A draft closing wakes us; otherwise wait out the quiet period.
                let wait = if pending.is_empty() || inner.gate.drafting() { None } else { Some(inner.gate.wait_ms(now).max(100)) };
                (ready, wait)
            };
            if ready {
                // Another wait may have taken these meanwhile: read again while holding the lock,
                // and keep holding it until they're marked delivered.
                let guard = live.deliver.lock().await;
                let pending = self.store.undelivered(id).await?;
                if !pending.is_empty() {
                    return Ok(Some((pending, guard)));
                }
            }
            let sleep_until = match wait {
                Some(ms) => (tokio::time::Instant::now() + Duration::from_millis(ms)).min(deadline),
                None => deadline,
            };
            tokio::select! {
                _ = &mut notified => {}
                _ = tokio::time::sleep_until(sleep_until) => {}
            }
            if tokio::time::Instant::now() >= deadline {
                return Ok(None);
            }
        }
    }

    /// Mark `pending` delivered, tell pages, and describe it for the agent.
    async fn deliver(&self, id: &ReviewId, live: &Live, pending: &[Pending]) -> Result<FeedbackBatch> {
        let ids: Vec<MessageId> = pending.iter().map(|p| p.message.id.clone()).collect();

        // Read everything first: once the messages are marked delivered, nothing may
        // stop this call from returning them (an agent that gave up would lose them).
        let snap = App::snapshot(live);
        let mut threads = self.store.threads(id).await?;
        let mut chat: Vec<_> = self.store.chat(id).await?.into_iter().filter(|c| ids.contains(&c.id)).collect();
        let mut items: Vec<FeedbackItem> = Vec::new();
        let mut touched: Vec<ThreadId> = Vec::new();
        for p in pending {
            match &p.thread_id {
                None => items.push(FeedbackItem::Chat { message_id: p.message.id.0.clone(), body: p.message.body.clone() }),
                Some(tid) if touched.contains(tid) => {}
                Some(tid) => {
                    touched.push(tid.clone());
                    if let Some(t) = threads.iter().find(|t| &t.id == tid) {
                        items.push(thread_item(t, &ids, &snap));
                    }
                }
            }
        }
        let now = self.now();
        self.store.mark_delivered(&ids, now).await?;
        // Tell pages the messages were delivered.
        let delivered = |m: &mut diffd_core::model::Message| {
            if ids.contains(&m.id) {
                m.delivered_at = Some(now);
            }
        };
        for t in threads.iter_mut().filter(|t| touched.contains(&t.id)) {
            t.messages.iter_mut().for_each(delivered);
            App::broadcast(live, ServerMsg::Thread { thread: t.clone() });
        }
        for c in &mut chat {
            delivered(c);
            App::broadcast(live, ServerMsg::Chat { message: c.clone() });
        }

        let then = if self.hooks_active_for(id).await {
            "When you're done, end your turn: diffd wakes you when the user writes again, and meanwhile they can \
             talk to you directly."
        } else {
            "Then call wait_for_feedback again."
        };
        let next_step = format!(
            "Answer each thread with reply (thread_id), in the thread, where the code is. Answer chat items with say. \
             If you change code, the review updates by itself; say what you changed in your reply. {then}"
        );
        Ok(FeedbackBatch { review_id: id.0.clone(), url: self.url(id), items, next_step })
    }

    async fn hooks_active_for(&self, id: &ReviewId) -> bool {
        match self.meta(id).await {
            Ok((meta, _)) => self.hooks_active(std::path::Path::new(&meta.repo_path)),
            Err(_) => false,
        }
    }

    /// How many user messages are waiting for the agent.
    pub async fn pending_count(&self, id: &ReviewId) -> Result<usize> {
        Ok(self.store.undelivered(id).await?.len())
    }
}

/// Counts as an agent listening on a review for as long as it's held.
pub(super) struct Listening<'a> {
    app: &'a App,
    live: std::sync::Arc<super::Live>,
}

impl<'a> Listening<'a> {
    pub(super) fn start(app: &'a App, live: &std::sync::Arc<super::Live>) -> Self {
        live.inner.lock().expect("live lock").listeners += 1;
        app.agent_seen(live);
        Self { app, live: live.clone() }
    }
}

impl Drop for Listening<'_> {
    fn drop(&mut self) {
        let mut inner = self.live.inner.lock().expect("live lock");
        inner.listeners = inner.listeners.saturating_sub(1);
        drop(inner);
        self.app.agent_seen(&self.live);
    }
}

fn thread_item(t: &Thread, new_ids: &[MessageId], snap: &Snapshot) -> FeedbackItem {
    let (earlier, new): (Vec<_>, Vec<_>) = t.messages.iter().partition(|m| !new_ids.contains(&m.id));
    FeedbackItem::Thread {
        thread_id: t.id.0.clone(),
        path: t.anchor.path.clone(),
        side: match t.anchor.side {
            Side::Old => "old (before the change)".into(),
            Side::New => "new (after the change)".into(),
        },
        lines: [t.anchor.start, t.anchor.end],
        code: t.anchor.text.clone(),
        context: context(t, snap),
        earlier: earlier
            .into_iter()
            .map(|m| ThreadMessage {
                author: match m.author {
                    Author::User => "user".into(),
                    Author::Agent => "you".into(),
                },
                body: m.body.clone(),
            })
            .collect(),
        new: new.into_iter().map(|m| m.body.clone()).collect(),
        code_changed_since_comment: t.changed_in.is_some(),
        commented_on: t.anchor.range.as_ref().map(|r| format!("{}..{}", r.from, r.to.as_deref().unwrap_or("working tree"))),
        not_in_current_diff: t.outdated,
    }
}

fn context(t: &Thread, snap: &Snapshot) -> String {
    if t.outdated {
        return String::new();
    }
    let Some(file) = snap.files.iter().find(|f| f.path == t.anchor.path) else { return String::new() };
    let side = match t.anchor.side {
        Side::Old => file.old.as_ref(),
        Side::New => file.new.as_ref(),
    };
    let Some(side) = side else { return String::new() };
    let (a, b) = (t.anchor.start as usize, t.anchor.end as usize);
    let from = a.saturating_sub(CONTEXT_LINES).max(1);
    let to = (b + CONTEXT_LINES).min(side.lines.len());
    (from..=to)
        .map(|n| format!("{} {n:>5} | {}", if (a..=b).contains(&n) { ">" } else { " " }, side.lines[n - 1]))
        .collect::<Vec<_>>()
        .join("\n")
}
