//! Messages between the review page and the server, over one WebSocket.
//!
//! Both directions are tagged unions, generated into TypeScript, so the page
//! handles them with an exhaustive `match`.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{ActivityItem, Anchor, ChatMessage, MessageId, Presence, Region, ReviewMeta, ShowRequest, Snapshot, Thread, ThreadId};

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
    pub chat: Vec<ChatMessage>,
    pub activity: Vec<ActivityItem>,
    pub presence: Presence,
    /// Activity up to this sequence number has been seen by the user.
    #[ts(type = "number")]
    pub read_seq: u64,
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
    /// A thread was created or changed.
    Thread {
        thread: Thread,
    },
    Chat {
        message: ChatMessage,
    },
    Activity {
        item: ActivityItem,
    },
    Presence {
        presence: Presence,
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
            Self::Resolve { .. } | Self::Drafting { .. } | Self::Read { .. } => None,
        }
    }
}

/// Ids the page generates must look like ours: short, URL-safe.
pub fn valid_client_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
