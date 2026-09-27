//! Threads, notes, chat and "show me": everything said about a review.

use diffd_core::model::{
    ActivityKind, Anchor, Author, ChatMessage, Message, MessageId, NoteKind, Region, RegionKind, ReviewId, ShowRequest, Side, Snapshot,
    Thread, ThreadId, ThreadKind,
};
use diffd_core::protocol::ServerMsg;
use schemars::JsonSchema;
use serde::Deserialize;

use super::{App, AppError, Live, Result, new_id};

/// An agent note, as passed to `share_diff` or `annotate`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct NoteInput {
    /// Path of a file in the diff.
    pub file: String,
    /// First and last line (1-based, inclusive) in the new version, or the old one with `side: "old"`.
    pub lines: [u32; 2],
    #[serde(default)]
    pub side: Option<Side>,
    /// Markdown, 1–4 plain-language sentences.
    pub body: String,
    #[serde(default)]
    pub kind: Option<NoteKind>,
}

/// A region the agent labels, as passed to `share_diff` or `annotate`.
#[derive(Debug, Clone, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RegionInput {
    /// Path of a file in the diff.
    pub file: String,
    /// First and last line (1-based, inclusive). Omit to mean the whole file (tests only).
    #[serde(default)]
    pub lines: Option<[u32; 2]>,
    /// Which version the lines refer to (default: new).
    #[serde(default)]
    pub side: Option<Side>,
    /// `test`: test code, marked along its side. `fold`: folded by default behind `summary`.
    pub kind: RegionKind,
    /// Required for folds: what changed in there, in one plain sentence, e.g.
    /// "Renamed try_acquire to acquire at every call site".
    #[serde(default)]
    pub summary: Option<String>,
}

/// Validate region inputs against a snapshot and turn them into regions.
pub(super) fn regions_from(snap: &Snapshot, inputs: Vec<RegionInput>) -> Result<Vec<Region>> {
    inputs
        .into_iter()
        .map(|r| {
            let side = r.side.unwrap_or(Side::New);
            let summary = r.summary.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
            let text = match r.lines {
                Some([start, end]) => anchor_text(snap, &r.file, side, start, end)?,
                None => {
                    if r.kind == RegionKind::Fold {
                        return Err(AppError::Invalid(format!("fold on `{}` needs `lines`; use `collapse` to fold a whole file", r.file)));
                    }
                    if !snap.files.iter().any(|f| f.path == r.file) {
                        return Err(AppError::Invalid(format!("`{}` is not in this diff", r.file)));
                    }
                    String::new()
                }
            };
            if r.kind == RegionKind::Fold && summary.is_none() {
                return Err(AppError::Invalid(format!("fold on `{}` needs a `summary` saying what changed there", r.file)));
            }
            Ok(Region { path: r.file, side, lines: r.lines, kind: r.kind, summary, text })
        })
        .collect()
}

/// The exact text of `lines` on one side of a file, or why that's not possible.
pub(super) fn anchor_text(snap: &Snapshot, path: &str, side: Side, start: u32, end: u32) -> Result<String> {
    let file = snap.files.iter().find(|f| f.path == path).ok_or_else(|| {
        let paths: Vec<&str> = snap.files.iter().map(|f| f.path.as_str()).collect();
        AppError::Invalid(format!("`{path}` is not in this diff. Files: {}", paths.join(", ")))
    })?;
    let text = match side {
        Side::Old => file.old.as_ref(),
        Side::New => file.new.as_ref(),
    }
    .ok_or_else(|| AppError::Invalid(format!("`{path}` has no {side:?} side (it was added or deleted)")))?;
    let n = text.lines.len() as u32;
    if start == 0 || start > end || end > n {
        return Err(AppError::Invalid(format!("lines {start}-{end} are outside `{path}` ({n} lines on that side)")));
    }
    Ok(text.lines[start as usize - 1..end as usize].join("\n"))
}

impl App {
    fn message(&self, author: Author, body: &str) -> Result<Message> {
        self.message_with_id(MessageId(new_id("m")), author, body)
    }

    fn message_with_id(&self, id: MessageId, author: Author, body: &str) -> Result<Message> {
        let body = body.trim();
        if body.is_empty() {
            return Err(AppError::Invalid("message body is empty".into()));
        }
        if !diffd_core::protocol::valid_client_id(&id.0) {
            return Err(AppError::Invalid("bad message id".into()));
        }
        Ok(Message { id, author, body: body.to_owned(), created_at: self.now(), delivered_at: None })
    }

    /// The user touched something: hold feedback until they pause, and wake the agent.
    fn user_activity(&self, live: &Live) {
        live.inner.lock().expect("live lock").gate.touch(self.now());
        live.feedback.notify_waiters();
    }

    // -- From the page -------------------------------------------------------

    /// The user starts a thread on a selection. With page-chosen ids, a
    /// repeated request (after a reconnect) is a no-op.
    pub async fn comment(&self, id: &ReviewId, ids: Option<(ThreadId, MessageId)>, anchor: Anchor, body: &str) -> Result<Thread> {
        let live = self.live(id).await?;
        if let Some((thread_id, _)) = &ids {
            if !diffd_core::protocol::valid_client_id(&thread_id.0) {
                return Err(AppError::Invalid("bad thread id".into()));
            }
            if self.store.thread_exists(thread_id).await? {
                return self.store.thread(thread_id).await?.map(|(_, t)| t).ok_or_else(|| AppError::NotFound("thread".into()));
            }
        }
        let text = anchor_text(&App::snapshot(&live), &anchor.path, anchor.side, anchor.start, anchor.end)?;
        let (thread_id, message) = match ids {
            Some((t, m)) => (t, self.message_with_id(m, Author::User, body)?),
            None => (ThreadId(new_id("t")), self.message(Author::User, body)?),
        };
        let thread = Thread {
            id: thread_id,
            kind: ThreadKind::Comment,
            anchor: Anchor { text, ..anchor },
            resolved: false,
            changed_in: None,
            outdated: false,
            messages: vec![message],
            created_at: self.now(),
        };
        self.store.insert_thread(id, &thread).await?;
        self.store.touch_review(id, self.now()).await?;
        let kind =
            ActivityKind::UserCommented { thread_id: thread.id.clone(), path: thread.anchor.path.clone(), line: thread.anchor.start };
        let item = self.store.add_activity(id, self.now(), kind).await?;
        App::broadcast(&live, ServerMsg::Thread { thread: thread.clone() });
        App::broadcast(&live, ServerMsg::Activity { item });
        self.user_activity(&live);
        Ok(thread)
    }

    /// A reply in a thread, from either side. A page-chosen `message_id`
    /// makes a repeated request a no-op.
    pub async fn reply(
        &self,
        thread_id: &ThreadId,
        message_id: Option<MessageId>,
        author: Author,
        body: &str,
        resolve: Option<bool>,
    ) -> Result<Thread> {
        let (id, mut thread) =
            self.store.thread(thread_id).await?.ok_or_else(|| AppError::NotFound(format!("no thread with id `{thread_id}`")))?;
        if let Some(m) = &message_id
            && self.store.message_exists(m).await?
        {
            return Ok(thread);
        }
        let live = self.live(&id).await?;
        let msg = match message_id {
            Some(m) => self.message_with_id(m, author, body)?,
            None => self.message(author, body)?,
        };
        self.store.insert_message(&id, Some(thread_id), &msg).await?;
        thread.messages.push(msg);
        if let Some(resolved) = resolve {
            thread.resolved = resolved;
            self.store.update_thread(&thread).await?;
        }
        self.store.touch_review(&id, self.now()).await?;
        let (path, line) = (thread.anchor.path.clone(), thread.anchor.start);
        let kind = match author {
            Author::User => ActivityKind::UserCommented { thread_id: thread_id.clone(), path, line },
            Author::Agent => ActivityKind::AgentReplied { thread_id: thread_id.clone(), path, line },
        };
        let item = self.store.add_activity(&id, self.now(), kind).await?;
        App::broadcast(&live, ServerMsg::Thread { thread: thread.clone() });
        App::broadcast(&live, ServerMsg::Activity { item });
        match author {
            Author::User => self.user_activity(&live),
            Author::Agent => self.agent_seen(&live),
        }
        Ok(thread)
    }

    pub async fn resolve(&self, thread_id: &ThreadId, resolved: bool) -> Result<Thread> {
        let (id, mut thread) =
            self.store.thread(thread_id).await?.ok_or_else(|| AppError::NotFound(format!("no thread with id `{thread_id}`")))?;
        thread.resolved = resolved;
        self.store.update_thread(&thread).await?;
        let live = self.live(&id).await?;
        App::broadcast(&live, ServerMsg::Thread { thread: thread.clone() });
        Ok(thread)
    }

    /// A page opened (`true`) or closed (`false`) a comment draft.
    pub async fn drafting(&self, id: &ReviewId, drafting: bool) -> Result<()> {
        let live = self.live(id).await?;
        {
            let mut inner = live.inner.lock().expect("live lock");
            inner.drafting = if drafting { inner.drafting + 1 } else { inner.drafting.saturating_sub(1) };
            let open = inner.drafting > 0;
            inner.gate.set_drafting(open, self.now());
        }
        live.feedback.notify_waiters();
        Ok(())
    }

    /// A chat message from the user; a repeated `message_id` is a no-op.
    pub async fn chat_user(&self, id: &ReviewId, message_id: Option<MessageId>, body: &str) -> Result<()> {
        let live = self.live(id).await?;
        if let Some(m) = &message_id
            && self.store.message_exists(m).await?
        {
            return Ok(());
        }
        let msg = match message_id {
            Some(m) => self.message_with_id(m, Author::User, body)?,
            None => self.message(Author::User, body)?,
        };
        self.store.insert_message(id, None, &msg).await?;
        let chat = ChatMessage { id: msg.id, author: msg.author, body: msg.body, created_at: msg.created_at, delivered_at: None };
        App::broadcast(&live, ServerMsg::Chat { message: chat });
        self.user_activity(&live);
        Ok(())
    }

    pub async fn mark_read(&self, id: &ReviewId, seq: u64) -> Result<()> {
        self.store.set_read_seq(id, seq).await?;
        Ok(())
    }

    // -- From the agent ------------------------------------------------------

    /// Add agent notes; returns how many were added.
    pub async fn add_notes(&self, id: &ReviewId, notes: Vec<NoteInput>, announce: bool) -> Result<usize> {
        let live = self.live(id).await?;
        let snap = App::snapshot(&live);
        let existing = self.store.threads(id).await?;
        let mut order = existing
            .iter()
            .filter_map(|t| match t.kind {
                ThreadKind::Note { order, .. } => Some(order + 1),
                ThreadKind::Comment => None,
            })
            .max()
            .unwrap_or(0);
        // Validate everything first so a bad note doesn't leave half the batch behind.
        let mut threads = Vec::with_capacity(notes.len());
        for n in notes {
            let side = n.side.unwrap_or(Side::New);
            let [start, end] = n.lines;
            let text = anchor_text(&snap, &n.file, side, start, end)?;
            threads.push(Thread {
                id: ThreadId(new_id("n")),
                kind: ThreadKind::Note { kind: n.kind.unwrap_or(NoteKind::Explain), order },
                anchor: Anchor { path: n.file, side, start, end, text },
                resolved: false,
                changed_in: None,
                outdated: false,
                messages: vec![self.message(Author::Agent, &n.body)?],
                created_at: self.now(),
            });
            order += 1;
        }
        let count = threads.len();
        for t in threads {
            self.store.insert_thread(id, &t).await?;
            if announce {
                let kind = ActivityKind::AgentNoted { thread_id: t.id.clone(), path: t.anchor.path.clone(), line: t.anchor.start };
                let item = self.store.add_activity(id, self.now(), kind).await?;
                App::broadcast(&live, ServerMsg::Activity { item });
            }
            App::broadcast(&live, ServerMsg::Thread { thread: t });
        }
        self.agent_seen(&live);
        Ok(count)
    }

    /// Add test and fold regions.
    pub async fn add_regions(&self, id: &ReviewId, inputs: Vec<RegionInput>) -> Result<usize> {
        let live = self.live(id).await?;
        let regions = regions_from(&App::snapshot(&live), inputs)?;
        let n = regions.len();
        let (_, mut spec) = self.meta(id).await?;
        spec.regions.extend(regions);
        self.store.set_spec(id, &spec).await?;
        App::broadcast(&live, ServerMsg::Regions { regions: spec.regions });
        self.agent_seen(&live);
        Ok(n)
    }

    /// The agent writes in the chat box.
    pub async fn say(&self, id: &ReviewId, body: &str) -> Result<ChatMessage> {
        let live = self.live(id).await?;
        let msg = self.message(Author::Agent, body)?;
        self.store.insert_message(id, None, &msg).await?;
        let chat = ChatMessage { id: msg.id, author: msg.author, body: msg.body, created_at: msg.created_at, delivered_at: None };
        let item = self.store.add_activity(id, self.now(), ActivityKind::AgentSaid { message_id: chat.id.clone() }).await?;
        App::broadcast(&live, ServerMsg::Chat { message: chat.clone() });
        App::broadcast(&live, ServerMsg::Activity { item });
        self.agent_seen(&live);
        Ok(chat)
    }

    /// The agent points the user at some code. The page asks before jumping.
    pub async fn show(&self, id: &ReviewId, request: ShowRequest) -> Result<()> {
        let live = self.live(id).await?;
        anchor_text(&App::snapshot(&live), &request.path, request.side, request.start, request.end)?;
        let item = self.store.add_activity(id, self.now(), ActivityKind::Show { request: request.clone() }).await?;
        App::broadcast(&live, ServerMsg::Show { request });
        App::broadcast(&live, ServerMsg::Activity { item });
        self.agent_seen(&live);
        Ok(())
    }
}
