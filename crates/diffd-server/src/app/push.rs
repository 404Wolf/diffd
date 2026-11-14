//! Pushing feedback into the agent's Herdr inbox, so it hears the user within
//! seconds, even in the middle of a turn.
//!
//! The harness hooks (`wake`) wake an agent only between turns. When the
//! agent that shared a review runs in a Herdr terminal (its MCP calls carry
//! `X-Herdr-Terminal`) and its harness follows that terminal's inbox
//! (herdr-core's `hc inbox --follow`, e.g. Claude Code's herdr-messages
//! mod), the same notice goes into that inbox instead: the harness hands it
//! to the agent out of band, idle or mid-turn.
//!
//! The hooks stay the fallback and are never told to stand aside. Both take
//! feedback through [`App::take_notice`], which marks it told under the
//! review's lock, so each message is announced by exactly one of them:
//! - the pusher marks before it sends, so a hook waiter that looks meanwhile
//!   skips those messages;
//! - a send that fails (no Herdr, a core without inboxes, nothing following
//!   that inbox, hc failing) un-marks them and wakes the hook waiters, which
//!   deliver them at once.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use diffd_core::model::ReviewId;

use super::wake::Look;
use super::{App, Live, Result};
use crate::ports::AgentInbox;

impl App {
    /// Push feedback into agents' Herdr inboxes from now on (see the module docs).
    pub fn set_inbox(&self, inbox: Arc<dyn AgentInbox>) {
        let me = self.me.clone();
        let pushes = self.pushes.clone();
        tokio::spawn(async move {
            loop {
                let held = match me.upgrade() {
                    Some(app) => app.push(&inbox).await.unwrap_or_else(|e| {
                        tracing::warn!(error = %e, "can't push feedback to Herdr inboxes; the hooks deliver it");
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
        // Feedback already waiting can go to the new terminal.
        self.pushes.notify_one();
        Ok(())
    }

    /// The agent's Herdr terminal for review `id`, as last seen.
    pub async fn agent_terminal(&self, id: &ReviewId) -> Result<Option<String>> {
        Ok(self.meta(id).await?.1.agent_terminal)
    }

    /// One pass: each agent terminal gets one notice for all its reviews'
    /// fresh feedback. `Some` when feedback is held for the user's pause: look
    /// again after that long.
    async fn push(&self, inbox: &Arc<dyn AgentInbox>) -> Result<Option<Duration>> {
        let routes = self.routes().await;
        if routes.is_empty() {
            return Ok(None);
        }
        // No Herdr here: the hooks deliver everything, nothing is marked.
        let Some(core) = inbox.core_id().await else {
            return Ok(None);
        };
        let mut held: Option<Duration> = None;
        for ((terminal, route_core), lives) in routes {
            // An address from an earlier core may belong to someone else now.
            if route_core != core {
                continue;
            }
            match self.take_notice(&lives).await? {
                Look::Notice(notice, told) => {
                    let (Some(app), inbox) = (self.me.upgrade(), inbox.clone()) else { break };
                    // A send waits on the core for a moment; others needn't wait behind it.
                    tokio::spawn(async move {
                        if !inbox.send(&terminal, &notice.message).await {
                            tracing::debug!(terminal = %terminal, "Herdr inbox unavailable; the hooks deliver this feedback");
                            app.untell(told);
                        }
                    });
                }
                Look::Held(wait) => held = Some(held.map_or(wait, |h| h.min(wait))),
                Look::Nothing => {}
            }
        }
        Ok(held)
    }

    /// Reviews in memory whose agent runs in a Herdr terminal, by that
    /// terminal and its core. Feedback only arrives on reviews in memory.
    async fn routes(&self) -> BTreeMap<(String, String), Vec<(ReviewId, Arc<Live>)>> {
        let lives: Vec<(ReviewId, Arc<Live>)> = self.live.lock().expect("live lock").iter().map(|(id, l)| (id.clone(), l.clone())).collect();
        let mut routes: BTreeMap<_, Vec<_>> = BTreeMap::new();
        for (id, live) in lives {
            // A review deleted meanwhile has no route.
            let Ok((_, spec)) = self.meta(&id).await else { continue };
            if let (Some(terminal), Some(core)) = (spec.agent_terminal, spec.agent_core_id) {
                routes.entry((terminal, core)).or_default().push((id, live));
            }
        }
        routes
    }
}
