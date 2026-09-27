//! Messages between the review page and the server, over one WebSocket.
//!
//! Both directions are tagged unions, generated into TypeScript, so the page
//! handles them with an exhaustive `match`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use std::collections::BTreeMap;

use crate::model::{
    ActivityItem, Anchor, CodeAnswer, CodeQuery, Diagnostic, History, Layout, Message, MessageId, Presence, Region, ReviewMeta,
    ShowRequest, Snapshot, Thread, ThreadId,
};

/// Everything the page needs to render a review. It's embedded in the HTML so
/// the page works offline, and re-sent when the socket (re)connects.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewState {
    pub review: ReviewMeta,
    pub snapshot: Snapshot,
    pub threads: Vec<Thread>,
    /// Tests and folds the agent marked.
    pub regions: Vec<Region>,
    /// Who the agent is, and how it grouped and labelled the files.
    pub layout: Layout,
    /// The commits in the review's range.
    pub history: History,
    pub chat: Vec<Message>,
    pub activity: Vec<ActivityItem>,
    pub presence: Presence,
    /// Activity up to this sequence number has been seen by the user.
    #[ts(type = "number")]
    pub read_seq: u64,
    /// Language servers' diagnostics, by path (files in the diff and open for context).
    pub diagnostics: BTreeMap<String, Vec<Diagnostic>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum ServerMsg {
    /// Full state, sent on connect.
    State {
        state: Box<ReviewState>,
    },
    /// A new revision of the diff.
    Revision {
        review: ReviewMeta,
        snapshot: Box<Snapshot>,
    },
    /// The agent's region labels changed.
    Regions {
        regions: Vec<Region>,
    },
    /// The agent regrouped or relabelled the files.
    Layout {
        layout: Layout,
    },
    /// A thread was created or changed.
    Thread {
        thread: Thread,
    },
    Chat {
        message: Message,
    },
    Activity {
        item: ActivityItem,
    },
    Presence {
        presence: Presence,
    },
    /// A file's diagnostics changed (an empty list clears them).
    Diagnostics {
        path: String,
        diagnostics: Vec<Diagnostic>,
    },
    /// The answer to a `ClientMsg::Code` question.
    #[serde(rename_all = "camelCase")]
    Code {
        request_id: u32,
        answer: CodeAnswer,
    },
    /// New commits landed in the review's range.
    History {
        history: History,
    },
    /// The agent wants to point the user at some code.
    Show {
        request: ShowRequest,
    },
    /// The server applied the page's message with this id (see [`ClientMsg`]).
    Ack {
        id: MessageId,
    },
    /// A request from the page failed.
    Error {
        message: String,
    },
    /// The review no longer exists (it was deleted): stop reconnecting.
    Gone {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
#[ts(export)]
pub enum ClientMsg {
    /// Start a thread on a selection. The page picks the ids, so sending the
    /// same message twice (e.g. after a reconnect) has no extra effect.
    #[serde(rename_all = "camelCase")]
    Comment { thread_id: ThreadId, message_id: MessageId, anchor: Anchor, body: String },
    #[serde(rename_all = "camelCase")]
    Reply { thread_id: ThreadId, message_id: MessageId, body: String },
    #[serde(rename_all = "camelCase")]
    Resolve { thread_id: ThreadId, resolved: bool },
    /// The user opened or closed a comment draft; open drafts hold feedback back.
    Drafting { drafting: bool },
    /// A message in the chat box.
    #[serde(rename_all = "camelCase")]
    Chat { message_id: MessageId, body: String },
    /// The user has seen activity up to `seq`.
    Read {
        #[ts(type = "number")]
        seq: u64,
    },
    /// Ask a language server about a position in a file on the new side
    /// (line 1-based, column in UTF-16 code units). Answered with `ServerMsg::Code`.
    #[serde(rename_all = "camelCase")]
    Code { request_id: u32, query: CodeQuery, path: String, line: u32, col: u32 },
}

/// A review in the recent list on the home page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReviewSummary {
    pub review: ReviewMeta,
    /// Agent activity the user hasn't seen.
    pub unread: u32,
}

/// What the server embeds in each page it serves; the page renders from it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "page", rename_all = "camelCase")]
#[ts(export)]
pub enum Boot {
    Home { reviews: Vec<ReviewSummary> },
    Review { state: Box<ReviewState> },
    NotFound { message: String },
}

impl ClientMsg {
    /// The id the server acknowledges once it has applied this message.
    pub fn ack_id(&self) -> Option<&MessageId> {
        match self {
            Self::Comment { message_id, .. } | Self::Reply { message_id, .. } | Self::Chat { message_id, .. } => Some(message_id),
            Self::Resolve { .. } | Self::Drafting { .. } | Self::Read { .. } | Self::Code { .. } => None,
        }
    }
}

/// Ids the page generates must look like ours: short, URL-safe.
pub fn valid_client_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
