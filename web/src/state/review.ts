/**
 * The review's data, kept in sync with the server. The snapshot is held as
 * one immutable value (it can be very large); threads, chat and activity are
 * small and live in a Solid store.
 */
import { batch, createEffect, createMemo, createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { match } from "ts-pattern";
import type { ActivityItem } from "../gen/ActivityItem";
import type { Anchor } from "../gen/Anchor";
import type { ChatMessage } from "../gen/ChatMessage";
import type { ClientMsg } from "../gen/ClientMsg";
import type { CodeAnswer } from "../gen/CodeAnswer";
import type { CodeQuery } from "../gen/CodeQuery";
import type { CommitRange } from "../gen/CommitRange";
import type { Diagnostic } from "../gen/Diagnostic";
import type { FileDiff } from "../gen/FileDiff";
import type { History } from "../gen/History";
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
import { carrySpan, rangeOf, relocate, type Span } from "../lib/history";
import { type Connection, connect, type Socket } from "../lib/socket";

interface Conversation {
  /** Language servers' diagnostics, by path. */
  diagnostics: Partial<Record<string, Diagnostic[]>>;
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
  /** Now showing a different part of the history. */
  onSpan?: () => void;
}

/** A little longer than the server's own timeout, so its answer usually wins. */
const CODE_TIMEOUT_MS = 12_000;

export function createReview(initial: ReviewState, events: ReviewEvents = {}) {
  const [meta, setMeta] = createSignal<ReviewMeta>(initial.review);
  /** The whole review's diff, as the server keeps it. */
  const [whole, setWhole] = createSignal<Snapshot>(initial.snapshot);
  const [history, setHistory] = createSignal<History>(initial.history);
  const [conv, setConv] = createStore<Conversation>({
    diagnostics: initial.diagnostics,
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
  // -- Walking the history ---------------------------------------------------------
  const [span, setSpan] = createSignal<Span>(null);
  const [spanSnapshot, setSpanSnapshot] = createSignal<Snapshot | null>(null);
  const [loadingSpan, setLoadingSpan] = createSignal<Span | undefined>(undefined);
  /** Diffs of parts of the history, by range. Ranges ending at the working tree are dropped on every revision. */
  const spanCache = new Map<string, Snapshot>();
  const rangeKey = (r: CommitRange) => `${r.from}..${r.to ?? ""}`;
  let spanRequest = 0;
  /** Show part of the history (`null`: the whole review). */
  const showSpan = async (next: Span) => {
    const request = ++spanRequest;
    const range = rangeOf(history(), next);
    if (next === null || range === null) {
      setLoadingSpan(undefined);
      batch(() => {
        setSpan(null);
        setSpanSnapshot(null);
      });
      events.onSpan?.();
      return;
    }
    let snap = spanCache.get(rangeKey(range));
    if (!snap) {
      setLoadingSpan(next);
      try {
        snap = await fetchRange(initial.review.id, range);
      } catch (e) {
        if (request === spanRequest) setLoadingSpan(undefined);
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      spanCache.set(rangeKey(range), snap);
    }
    if (request !== spanRequest) return;
    setLoadingSpan(undefined);
    batch(() => {
      setSpan(next);
      setSpanSnapshot(snap);
    });
    events.onSpan?.();
  };
  /** The diff on screen: the whole review, or the part of its history being walked. */
  const diff = createMemo<Snapshot>(() => spanSnapshot() ?? whole());

  // -- Files outside the diff --------------------------------------------------------
  // Opened for context (from the tree, by the agent's `show`, or because a thread is
  // on one). They're appended to the snapshot's files as "unchanged" files, so the
  // cursor, file view, comments and marks all work on them as on any other file.
  const [context, setContext] = createSignal<FileDiff[]>([]);
  const loadingContext = new Map<string, Promise<FileDiff | null>>();
  const fetchContext = (path: string): Promise<FileDiff | null> => {
    const q = new URLSearchParams({ path });
    return fetch(`/api/reviews/${encodeURIComponent(initial.review.id)}/context?${q}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.text()) || `Couldn't open ${path}`);
        return (await res.json()) as FileDiff;
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      });
  };
  /** Open a file outside the diff; resolves to its index in the snapshot, or null. */
  const openContext = async (path: string): Promise<number | null> => {
    const at = snapshot().files.findIndex((f) => f.path === path);
    if (at >= 0) return at;
    let pending = loadingContext.get(path);
    if (!pending) {
      pending = fetchContext(path);
      loadingContext.set(path, pending);
    }
    const file = await pending;
    loadingContext.delete(path);
    if (!file) return null;
    if (!context().some((f) => f.path === path)) setContext((c) => [...c, file]);
    const index = snapshot().files.findIndex((f) => f.path === path);
    return index >= 0 ? index : null;
  };
  /** Files change as the agent works: read the open ones again. */
  const refreshContext = async () => {
    const fresh = await Promise.all(context().map((f) => fetchContext(f.path)));
    setContext((c) => c.map((f, i) => fresh[i] ?? f));
  };
  const [repoFiles, setRepoFiles] = createSignal<string[] | null>(null);
  let loadingRepoFiles = false;
  /** Every file in the repository, fetched the first time it's needed. */
  const loadRepoFiles = () => {
    if (repoFiles() !== null || loadingRepoFiles) return;
    loadingRepoFiles = true;
    fetch(`/api/reviews/${encodeURIComponent(initial.review.id)}/files`)
      .then((res) => (res.ok ? (res.json() as Promise<string[]>) : Promise.reject(new Error(res.statusText))))
      .then(setRepoFiles)
      .catch(() => setError("Couldn't list the repository's files"))
      .finally(() => {
        loadingRepoFiles = false;
      });
  };

  /** What's on screen: the diff, then any files opened for context. */
  const snapshot = createMemo<Snapshot>(() => {
    const base = diff();
    const inDiff = new Set(base.files.map((f) => f.path));
    const extra = context().filter((f) => !inDiff.has(f.path));
    return extra.length === 0 ? base : { ...base, files: [...base.files, ...extra] };
  });
  // Threads on files outside the review bring those files in, so the threads have somewhere to show.
  // (Walking commits, threads on files another commit changed just aren't shown.)
  const triedContext = new Set<string>();
  createEffect(() => {
    const paths = new Set(whole().files.map((f) => f.path));
    for (const t of allThreads()) {
      const path = t.anchor.path;
      if (paths.has(path) || triedContext.has(path)) continue;
      triedContext.add(path);
      void openContext(path);
    }
  });
  /** Files in the diff come first in `snapshot().files`; files opened for context follow. */
  const diffCount = () => diff().files.length;
  const range = createMemo(() => rangeOf(history(), span()));

  /** The server's threads with anything still in the outbox folded in, so nothing written disappears. */
  const allThreads = createMemo<Thread[]>(() => {
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
  /** Threads where they are in what's shown: moved into part of the history by their code, when it's there. */
  const threads = createMemo<Thread[]>(() => {
    const snap = spanSnapshot();
    if (!snap) return allThreads();
    return allThreads().flatMap((t) => {
      const anchor = relocate(t.anchor, snap);
      return anchor ? [{ ...t, anchor }] : [];
    });
  });
  const regions = createMemo<Region[]>(() => {
    const snap = spanSnapshot();
    if (!snap) return conv.regions;
    return conv.regions.flatMap((r) => {
      if (!snap.files.some((f) => f.path === r.path)) return [];
      if (r.lines === null) return [r];
      const [start, end] = r.lines;
      const at = relocate({ path: r.path, side: r.side, start, end, text: r.text, range: null }, snap);
      return at ? [{ ...r, side: at.side, lines: [at.start, at.end] as [number, number] }] : [];
    });
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
    threads()
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

  /** Messages that move content around go through `layout`, so the reader's place is kept. */
  const apply = (msg: ServerMsg) => {
    const moves =
      msg.type === "state" || msg.type === "revision" || msg.type === "thread" || msg.type === "regions";
    if (moves && events.layout) events.layout(() => applyNow(msg));
    else applyNow(msg);
  };
  const applyNow = (msg: ServerMsg) =>
    match(msg)
      .with({ type: "state" }, ({ state }) =>
        batch(() => {
          const prev = whole();
          setMeta(state.review);
          if (state.snapshot.revision !== prev.revision) {
            setWhole(state.snapshot);
            events.onRevision?.(prev, state.snapshot);
            refreshWorktreeSpan();
          }
          followHistory(state.history);
          setConv({
            diagnostics: reconcile(state.diagnostics)(conv.diagnostics),
            threads: reconcile(state.threads, { key: "id" })(conv.threads),
            // A new array would re-render every file's rows; only replace real changes.
            regions: sameJson(conv.regions, state.regions) ? conv.regions : state.regions,
            chat: state.chat,
            activity: state.activity,
            presence: state.presence,
            readSeq: state.readSeq,
          });
        }),
      )
      .with({ type: "revision" }, ({ review, snapshot: next }) => {
        const prev = whole();
        batch(() => {
          setMeta(review);
          setWhole(next);
        });
        events.onRevision?.(prev, next);
        refreshWorktreeSpan();
        void refreshContext();
      })
      .with({ type: "history" }, ({ history: next }) => followHistory(next))
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
      .with({ type: "gone" }, ({ message }) => setError(`${message} This page is now a read-only copy.`))
      // The socket consumes acks itself; they never reach here.
      .with({ type: "ack" }, () => {})
      .with({ type: "diagnostics" }, ({ path, diagnostics }) => setConv("diagnostics", path, diagnostics))
      .with({ type: "code" }, ({ requestId, answer }) => {
        codeRequests.get(requestId)?.(answer);
        codeRequests.delete(requestId);
      })
      .exhaustive();

  /** Files changed: diffs that end at the working tree are stale now. */
  const refreshWorktreeSpan = () => {
    for (const key of spanCache.keys()) if (key.endsWith("..")) spanCache.delete(key);
    if (range()?.to === null) void showSpan(span());
  };
  /** Commits were added (or rewritten): keep showing the same commits when they're still there. */
  const followHistory = (next: History) => {
    const prev = history();
    if (JSON.stringify(prev) === JSON.stringify(next)) return;
    const carried = carrySpan(prev, next, span());
    batch(() => {
      setHistory(next);
      setSpan(carried);
    });
    if (carried === null && spanSnapshot() !== null) void showSpan(null);
  };

  // -- Language servers ------------------------------------------------------------
  const codeRequests = new Map<number, (answer: CodeAnswer) => void>();
  let nextCodeRequest = 1;
  /** Ask a language server about a position on the new side (line 1-based, column in UTF-16 units). */
  const ask = (query: CodeQuery, path: string, line: number, col: number): Promise<CodeAnswer> => {
    if (!socket || connection() !== "live")
      return Promise.resolve({ type: "unavailable", reason: "not connected to diffd" });
    const requestId = nextCodeRequest++;
    return new Promise<CodeAnswer>((resolve) => {
      const timer = setTimeout(() => {
        codeRequests.delete(requestId);
        resolve({ type: "unavailable", reason: "the language server took too long" });
      }, CODE_TIMEOUT_MS);
      codeRequests.set(requestId, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
      socket?.send({ type: "code", requestId, query, path, line, col });
    });
  };

  let socket: Socket | null = null;
  const start = () => {
    socket = connect(initial.review.id, { onMessage: apply, onStatus: setConnection, onOutbox: setOutbox });
  };
  const send = (msg: ClientMsg) => {
    if (connection() === "gone") setError("This review was deleted; nothing more can be sent.");
    else if (socket) socket.send(msg);
    else setError("Not connected to diffd; this page is a read-only copy.");
  };

  return {
    meta,
    snapshot,
    whole,
    history,
    diffCount,
    isContext: (file: number) => file >= diffCount(),
    openContext,
    repoFiles,
    loadRepoFiles,
    span,
    range,
    loadingSpan,
    showSpan,
    regions,
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
    ask,
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

/** The diff between two points of a review's history. */
async function fetchRange(reviewId: string, range: CommitRange): Promise<Snapshot> {
  const q = new URLSearchParams({ from: range.from });
  if (range.to !== null) q.set("to", range.to);
  const res = await fetch(`/api/reviews/${encodeURIComponent(reviewId)}/range?${q}`);
  if (!res.ok) throw new Error((await res.text()) || `Couldn't load those commits (${res.status})`);
  return (await res.json()) as Snapshot;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
