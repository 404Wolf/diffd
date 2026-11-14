//! Pushing feedback into the agent's Herdr inbox, so it hears the user within
//! seconds, even in the middle of a turn.
//!
//! The harness hooks (`wake`) wake an agent only between turns. When the
//! agent that shared a review runs in a Herdr terminal (its MCP calls carry
//! `X-Herdr-Terminal`) and that terminal's core takes inbox-only messages
//! (herdr-core's `terminal.queue`), the notice goes into the terminal's inbox
//! instead: a harness that follows it (Claude Code's herdr-messages mod)
//! hands it to the agent out of band, idle or mid-turn.
//!
//! Each review's feedback is announced by one path at a time, its
//! [`Delivery`]. The inbox is preferred: while a review has a route the
//! pusher can use, hook waiters stand down for it, even when one is already
//! waiting. They take it back only on the pusher's word:
//! - a review with a route is `Deciding` from the moment feedback changes
//!   until the pusher has looked (hooks wait, the pusher decides);
//! - the pusher makes it `Inbox` when the route's core is this core and takes
//!   inbox-only messages, `Hooks` otherwise (no Herdr, another core, a core
//!   that predates them);
//! - a send the core definitely refused (nothing follows that inbox) puts it
//!   back to `Hooks`, un-marks the messages and wakes the hook waiters, which
//!   announce them at once. It stays with the hooks until the next feedback.
//!
//! Each notice has a key, and the core queues a key once: it remembers the
//! keys it queued for `queue_keys_kept_ms` (an hour), with the terminal,
//! across restarts. So a send whose outcome is unknown (no answer in time, a
//! lost core) is sent again, the same notice under the same key to the same
//! core, backing off from 1 s, for at most half that time:
//! - queued (now, or before: `repeated`): done;
//! - refused by the core, which checks its keys first (nothing follows that
//!   inbox): it never queued it, so the hooks announce it;
//! - not queued now by something that can't speak for an earlier attempt
//!   (another core took the address, a key it may have forgotten, an old
//!   core or hc), or still unclear at the end of the window: the hooks
//!   announce it. An earlier attempt may have gone in, so the agent may get
//!   two notices; that's harmless (`wait_for_feedback` hands out each comment
//!   once), and losing the only notice isn't. Within the window the core
//!   still has the key, so a retry itself can't queue it twice.
//!
//! So the notice is at least once, and twice only after an unclear answer.
//! Its messages stay told while the inbox tries, so the hooks don't
//! announce it meanwhile.
//!
//! A pass that fails part way (the database) hands the reviews it was
//! taking to the hooks, so their feedback is still announced.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use diffd_core::model::ReviewId;

use super::wake::{Look, Taker, Told};
use super::{App, Live, Result, new_id};
use crate::adapters::store::ReviewSpec;
use crate::ports::{AgentInbox, InboxCore, Outgoing, Sent};

/// Who announces a review's feedback (see the module docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum Delivery {
    /// The harness hooks: no route, or the inbox refused.
    #[default]
    Hooks,
    /// Feedback changed on a review with a route: the pusher decides.
    Deciding,
    /// The agent's Herdr inbox.
    Inbox,
}

/// How long the first retry of a send with an unknown outcome waits, and the
/// longest any waits.
const RETRY_FIRST: Duration = Duration::from_secs(1);
const RETRY_MAX: Duration = Duration::from_secs(60);
/// Retries stop at this share of how long the core keeps keys, well before it
/// could forget one.
const RETRY_SHARE_OF_KEYS_KEPT: u32 = 2;

/// The agent's Herdr terminal and that terminal's core, from a review's spec.
pub(super) fn route_of(spec: &ReviewSpec) -> Option<(String, String)> {
    Some((spec.agent_terminal.clone()?, spec.agent_core_id.clone()?))
}

impl App {
    /// Push feedback into agents' Herdr inboxes from now on (see the module docs).
    pub fn set_inbox(&self, inbox: Arc<dyn AgentInbox>) {
        *self.inbox.lock().expect("inbox lock") = Some(inbox.clone());
        self.pushing.store(true, Ordering::SeqCst);
        let me = self.me.clone();
        let pushes = self.pushes.clone();
        tokio::spawn(async move {
            loop {
                let held = match me.upgrade() {
                    Some(app) => app.push(&inbox).await.unwrap_or_else(|e| {
                        tracing::warn!(error = %e, "can't push feedback to Herdr inboxes");
                        None
                    }),
                    None => return,
                };
                // Looks again when feedback changes, or when held feedback could go out.
                match held {
                    Some(wait) => {
                        let _ = tokio::time::timeout(wait, pushes.notified()).await;
                    }
                    None => pushes.notified().await,
                }
            }
        });
    }

    /// The local Herdr core, if a pusher runs and a core answers.
    pub async fn inbox_core(&self) -> Option<InboxCore> {
        let inbox = self.inbox.lock().expect("inbox lock").clone()?;
        inbox.local_core().await
    }

    /// Where the agent working on review `id` runs: its own Herdr terminal and
    /// that terminal's core. Feedback is pushed there from now on.
    pub async fn agent_at(&self, id: &ReviewId, terminal: String, core_id: String) -> Result<()> {
        let live = self.live(id).await?;
        // Rebuild and annotate also write spec; don't let either overwrite this.
        let _guard = live.rebuild.lock().await;
        let (_, mut spec) = self.meta(id).await?;
        if spec.agent_terminal.as_deref() == Some(terminal.as_str()) && spec.agent_core_id.as_deref() == Some(core_id.as_str()) {
            return Ok(());
        }
        spec.agent_terminal = Some(terminal);
        spec.agent_core_id = Some(core_id);
        self.store.set_spec(id, &spec).await?;
        live.inner.lock().expect("live lock").route = route_of(&spec);
        // Feedback already waiting goes to the new terminal.
        self.feedback_changed(&live);
        Ok(())
    }

    /// The agent's Herdr route for review `id` (terminal, core id), as last seen.
    pub async fn agent_route(&self, id: &ReviewId) -> Result<Option<(String, String)>> {
        Ok(route_of(&self.meta(id).await?.1))
    }

    /// One pass: decide the delivery of each review the hooks don't have,
    /// then give each agent terminal one notice for its reviews' fresh
    /// feedback. `Some` when feedback is held for the user's pause: look
    /// again after that long.
    async fn push(&self, inbox: &Arc<dyn AgentInbox>) -> Result<Option<Duration>> {
        let lives: Vec<(ReviewId, Arc<Live>)> =
            self.live.lock().expect("live lock").iter().map(|(id, l)| (id.clone(), l.clone())).collect();
        let lives: Vec<_> =
            lives.into_iter().filter(|(_, l)| l.inner.lock().expect("live lock").delivery != Delivery::Hooks).collect();
        if lives.is_empty() {
            return Ok(None);
        }
        let core = inbox.local_core().await;
        let mut by_terminal: BTreeMap<String, Vec<(ReviewId, Arc<Live>)>> = BTreeMap::new();
        for (id, live) in lives {
            let (decided, terminal) = {
                let mut inner = live.inner.lock().expect("live lock");
                let usable = match (&inner.route, &core) {
                    (Some((_, route_core)), Some(core)) => core.queues && *route_core == core.id,
                    _ => false,
                };
                inner.delivery = if usable { Delivery::Inbox } else { Delivery::Hooks };
                (inner.delivery, inner.route.as_ref().map(|(terminal, _)| terminal.clone()))
            };
            match (decided, terminal) {
                (Delivery::Inbox, Some(terminal)) => by_terminal.entry(terminal).or_default().push((id, live)),
                // No usable route: the hook waiters, standing down until now, look again.
                _ => live.feedback.notify_waiters(),
            }
        }
        let mut held: Option<Duration> = None;
        for (terminal, lives) in by_terminal {
            // Only reviews on this core's routes are the inbox's.
            let Some(core) = core.clone() else { break };
            let look = match self.take_notice(&lives, Taker::Inbox).await {
                Ok(look) => look,
                Err(e) => {
                    // Nothing was sent, and take_notice un-marked what it took: the hooks can announce it.
                    tracing::warn!(error = %e, "can't take feedback for a Herdr inbox; the hooks announce it");
                    for (_, live) in &lives {
                        live.inner.lock().expect("live lock").delivery = Delivery::Hooks;
                        live.feedback.notify_waiters();
                    }
                    continue;
                }
            };
            let still_held = match look {
                Look::Notice(notice, told, still_held) => {
                    let (Some(app), inbox) = (self.me.upgrade(), inbox.clone()) else { break };
                    // A send waits on the core for a moment; others needn't wait behind it.
                    let outgoing = Outgoing {
                        terminal,
                        core: core.id,
                        key: new_id("diffd-"),
                        since_ms: self.now(),
                        text: notice.message,
                    };
                    let window = core.keys_kept / RETRY_SHARE_OF_KEYS_KEPT;
                    tokio::spawn(async move { app.deliver_notice(&*inbox, outgoing, window, told).await });
                    still_held
                }
                Look::Held(wait) => Some(wait),
                Look::Nothing => None,
            };
            if let Some(wait) = still_held {
                held = Some(held.map_or(wait, |h| h.min(wait)));
            }
        }
        Ok(held)
    }

    /// Sends one notice, the same on every attempt, until it's settled or
    /// `window` is up (see the module docs).
    async fn deliver_notice(&self, inbox: &dyn AgentInbox, notice: Outgoing, window: Duration, told: Vec<Told>) {
        let terminal = notice.terminal.as_str();
        let started = tokio::time::Instant::now();
        let mut unclear = false;
        let mut wait = RETRY_FIRST;
        loop {
            match inbox.send(&notice).await {
                Sent::Queued => return,
                Sent::Refused => {
                    tracing::debug!(terminal, "Herdr inbox refused; the hooks announce this feedback");
                    return self.hand_to_hooks(told);
                }
                Sent::Unvouched => {
                    if unclear {
                        tracing::warn!(terminal, "Herdr inbox can't say whether an earlier send went in; the hooks announce it too");
                    } else {
                        tracing::debug!(terminal, "Herdr inbox can't take it; the hooks announce this feedback");
                    }
                    return self.hand_to_hooks(told);
                }
                Sent::Unknown => {
                    unclear = true;
                    if started.elapsed() + wait > window {
                        tracing::warn!(terminal, "no clear answer from Herdr's inbox in time; the hooks announce it too");
                        return self.hand_to_hooks(told);
                    }
                    tracing::warn!(terminal, ?wait, "no clear answer from Herdr's inbox; asking again with the same key");
                    tokio::time::sleep(wait).await;
                    wait = (wait * 2).min(RETRY_MAX);
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "push_tests.rs"]
mod tests;
