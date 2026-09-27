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
      .exhaustive();

  let socket: Socket | null = null;
  const start = () => {
    socket = connect(initial.review.id, apply, setConnection);
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
    comment: (anchor: Anchor, body: string) => send({ type: "comment", anchor, body }),
    reply: (threadId: ThreadId, body: string) => send({ type: "reply", threadId, body }),
    resolve: (threadId: ThreadId, resolved: boolean) => send({ type: "resolve", threadId, resolved }),
    drafting: (drafting: boolean) => send({ type: "drafting", drafting }),
    chat: (body: string) => send({ type: "chat", body }),
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
