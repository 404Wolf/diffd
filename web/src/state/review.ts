/**
 * The review's data, kept in sync with the server. The snapshot is held as
 * one immutable value (it can be very large); threads, chat and activity are
 * small and live in a Solid store.
 */
import { batch, createMemo, createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { match } from "ts-pattern";
import type { ActivityItem } from "../gen/ActivityItem";
import type { Anchor } from "../gen/Anchor";
import type { ChatMessage } from "../gen/ChatMessage";
import type { ClientMsg } from "../gen/ClientMsg";
import type { Message } from "../gen/Message";
import type { MessageId } from "../gen/MessageId";
import type { Presence } from "../gen/Presence";
import type { Region } from "../gen/Region";
import type { ReviewMeta } from "../gen/ReviewMeta";
import type { ReviewState } from "../gen/ReviewState";
import type { ServerMsg } from "../gen/ServerMsg";
import type { ShowRequest } from "../gen/ShowRequest";
import type { Snapshot } from "../gen/Snapshot";
import type { Thread } from "../gen/Thread";
import type { ThreadId } from "../gen/ThreadId";
import { type FileModel, fileModel } from "../lib/diffModel";
import { type Connection, connect, type Socket } from "../lib/socket";

interface Conversation {
  threads: Thread[];
  regions: Region[];
  chat: ChatMessage[];
  activity: ActivityItem[];
  presence: Presence;
  readSeq: number;
}

export interface ReviewEvents {
  /** Wraps every change that moves content around, so the view can keep the reader's place. */
  layout?: (update: () => void) => void;
  /** A new revision arrived; the view keeps the reader's place. */
  onRevision?: (prev: Snapshot, next: Snapshot) => void;
  onShow?: (request: ShowRequest) => void;
}

export function createReview(initial: ReviewState, events: ReviewEvents = {}) {
  const [meta, setMeta] = createSignal<ReviewMeta>(initial.review);
  const [snapshot, setSnapshot] = createSignal<Snapshot>(initial.snapshot);
  const [conv, setConv] = createStore<Conversation>({
    threads: initial.threads,
    regions: initial.regions,
    chat: initial.chat,
    activity: initial.activity,
    presence: initial.presence,
    readSeq: initial.readSeq,
  });
  const [connection, setConnection] = createSignal<Connection>("connecting");
  const [error, setError] = createSignal<string | null>(null);
  const [outbox, setOutbox] = createSignal<ClientMsg[]>([]);

  /** Ids of messages written here that the server hasn't confirmed yet. */
  const pendingIds = createMemo(
    () =>
      new Set(
        outbox().flatMap((m) =>
          m.type === "comment" || m.type === "reply" || m.type === "chat" ? [m.messageId] : [],
        ),
      ),
  );
  /** The server's threads with anything still in the outbox folded in, so nothing written disappears. */
  const threads = createMemo<Thread[]>(() => {
    const queued = outbox();
    if (queued.length === 0) return conv.threads;
    const known = new Set(conv.threads.flatMap((t) => t.messages.map((m) => m.id)));
    const extra = new Map<string, Message[]>();
    const fresh: Thread[] = [];
    for (const msg of queued) {
      if (msg.type === "comment" && !known.has(msg.messageId)) {
        fresh.push({
          id: msg.threadId,
          kind: { type: "comment" },
          anchor: msg.anchor,
          resolved: false,
          changedIn: null,
          outdated: false,
          messages: [queuedMessage(msg.messageId, msg.body)],
          createdAt: Date.now(),
        });
      } else if (msg.type === "reply" && !known.has(msg.messageId)) {
        const list = extra.get(msg.threadId) ?? [];
        list.push(queuedMessage(msg.messageId, msg.body));
        extra.set(msg.threadId, list);
      }
    }
    const merged = conv.threads.map((t) => {
      const more = extra.get(t.id);
      return more ? { ...t, messages: [...t.messages, ...more] } : t;
    });
    for (const t of fresh) {
      const more = extra.get(t.id);
      merged.push(more ? { ...t, messages: [...t.messages, ...more] } : t);
    }
    return merged;
  });
  const chat = createMemo<ChatMessage[]>(() => {
    const known = new Set(conv.chat.map((c) => c.id));
    const queued = outbox().flatMap((m) =>
      m.type === "chat" && !known.has(m.messageId) ? [queuedMessage(m.messageId, m.body)] : [],
    );
    return queued.length === 0 ? conv.chat : [...conv.chat, ...queued];
  });

  const models = createMemo<FileModel[]>(() => snapshot().files.map(fileModel));
  const paths = createMemo(() => snapshot().files.map((f) => f.path));
  const definedNames = createMemo(() => new Set(snapshot().symbols.map((s) => s.name)));
  const notes = createMemo(() =>
    conv.threads
      .filter((t) => t.kind.type === "note")
      .sort((a, b) => (a.kind.type === "note" && b.kind.type === "note" ? a.kind.order - b.kind.order : 0)),
  );
  const unread = createMemo(() => conv.activity.filter((a) => a.seq > conv.readSeq && fromAgent(a)));

  const upsertThread = (thread: Thread) =>
    setConv(
      "threads",
      produce((threads) => {
        const i = threads.findIndex((t) => t.id === thread.id);
        if (i >= 0) threads[i] = thread;
        else threads.push(thread);
      }),
    );

  const apply = (msg: ServerMsg) => (events.layout ?? ((f) => f()))(() => applyNow(msg));
  const applyNow = (msg: ServerMsg) =>
    match(msg)
      .with({ type: "state" }, ({ state }) =>
        batch(() => {
          const prev = snapshot();
          setMeta(state.review);
          if (state.snapshot.revision !== prev.revision) {
            setSnapshot(state.snapshot);
            events.onRevision?.(prev, state.snapshot);
          }
          setConv({
            threads: reconcile(state.threads, { key: "id" })(conv.threads),
            regions: state.regions,
            chat: state.chat,
            activity: state.activity,
            presence: state.presence,
            readSeq: state.readSeq,
          });
        }),
      )
      .with({ type: "revision" }, ({ review, snapshot: next }) => {
        const prev = snapshot();
        batch(() => {
          setMeta(review);
          setSnapshot(next);
        });
        events.onRevision?.(prev, next);
      })
      .with({ type: "thread" }, ({ thread }) => upsertThread(thread))
      .with({ type: "regions" }, ({ regions }) => setConv("regions", regions))
      .with({ type: "chat" }, ({ message }) =>
        setConv(
          "chat",
          produce((chat) => {
            const i = chat.findIndex((c) => c.id === message.id);
            if (i >= 0) chat[i] = message;
            else chat.push(message);
          }),
        ),
      )
      .with({ type: "activity" }, ({ item }) => setConv("activity", (a) => [...a, item]))
      .with({ type: "presence" }, ({ presence }) => setConv("presence", presence))
      .with({ type: "show" }, ({ request }) => events.onShow?.(request))
      .with({ type: "error" }, ({ message }) => setError(message))
      // The socket consumes acks itself; they never reach here.
      .with({ type: "ack" }, () => {})
      .exhaustive();

  let socket: Socket | null = null;
  const start = () => {
    socket = connect(initial.review.id, { onMessage: apply, onStatus: setConnection, onOutbox: setOutbox });
  };
  const send = (msg: ClientMsg) => {
    if (socket) socket.send(msg);
    else setError("Not connected to diffd; this page is a read-only copy.");
  };

  return {
    meta,
    snapshot,
    conv,
    connection,
    error,
    clearError: () => setError(null),
    models,
    paths,
    definedNames,
    notes,
    unread,
    start,
    stop: () => socket?.close(),
    threads,
    chat,
    /** Whether a message is still waiting for the server to confirm it. */
    isPending: (id: MessageId) => pendingIds().has(id),
    pendingCount: () => pendingIds().size,
    comment: (anchor: Anchor, body: string) =>
      send({ type: "comment", threadId: newId(), messageId: newId(), anchor, body }),
    reply: (threadId: ThreadId, body: string) => send({ type: "reply", threadId, messageId: newId(), body }),
    resolve: (threadId: ThreadId, resolved: boolean) => send({ type: "resolve", threadId, resolved }),
    drafting: (drafting: boolean) => send({ type: "drafting", drafting }),
    say: (body: string) => send({ type: "chat", messageId: newId(), body }),
    markRead: (seq: number) => {
      if (seq <= conv.readSeq) return;
      setConv("readSeq", seq);
      send({ type: "read", seq });
    },
  };
}

export type Review = ReturnType<typeof createReview>;

export function fromAgent(a: ActivityItem): boolean {
  return match(a.kind)
    .with(
      { type: "agentReplied" },
      { type: "agentNoted" },
      { type: "agentSaid" },
      { type: "show" },
      { type: "revision" },
      () => true,
    )
    .with({ type: "opened" }, { type: "userCommented" }, () => false)
    .exhaustive();
}

function queuedMessage(id: MessageId, body: string): Message {
  return { id, author: "user", body, createdAt: Date.now(), deliveredAt: null };
}

/** A random id for something written here, so the server can tell a resend from a new message. */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `p${Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("")}`;
}
