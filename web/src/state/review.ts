/**
 * The review's data, kept in sync with the server. The snapshot is held as
 * one immutable value (it can be very large); threads, chat and activity are
 * small and live in a Solid store.
 */
import { batch, createEffect, createMemo, createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { match } from "ts-pattern";
import type {
  ActivityItem,
  Anchor,
  ClientMsg,
  CodeAnswer,
  CodeQuery,
  CommitRange,
  Diagnostic,
  FileDiff,
  History,
  Layout,
  LiveState,
  Message,
  MessageId,
  Presence,
  Region,
  ReviewMeta,
  ReviewState,
  ServerMsg,
  ShowRequest,
  Snapshot,
  SnapshotDelta,
  Thread,
  ThreadId,
} from "../api";
import * as api from "../api";
import { setAgentName } from "../lib/agent";
import { ok } from "../lib/api";
import { type FileModel, fileModel } from "../lib/diffModel";
import { carrySpan, rangeOf, relocate, type Span, stepAhead } from "../lib/history";
import { type FileGroup, labelsOf, resolveGroups } from "../lib/kinds";
import { Lru } from "../lib/lru";
import { type Connection, connect, type Socket } from "../lib/socket";
import { loadJson, saveJson } from "../lib/storage";

interface Conversation {
  /** Language servers' diagnostics, by path. */
  diagnostics: Partial<Record<string, Diagnostic[]>>;
  threads: Thread[];
  regions: Region[];
  chat: Message[];
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

/** Diffs of parts of the history kept in memory (the server keeps more). */
const MAX_CACHED_SPANS = 12;

/** A part of the history's diff: loaded, or on its way. */
interface SpanDiff {
  snapshot: Snapshot | null;
  loading: Promise<Snapshot>;
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
  /**
   * Diffs of parts of the history, loaded or on their way, by range. Ranges
   * ending at the working tree are dropped on every revision.
   */
  const spanCache = new Lru<string, SpanDiff>(MAX_CACHED_SPANS);
  const rangeKey = (r: CommitRange) => `${r.from}..${r.to ?? ""}`;
  const loadRange = (range: CommitRange): SpanDiff => {
    const key = rangeKey(range);
    const cached = spanCache.get(key);
    if (cached) return cached;
    const entry: SpanDiff = {
      snapshot: null,
      loading: fetchRange(initial.review.id, range).then(
        (snap) => {
          entry.snapshot = snap;
          return snap;
        },
        (e: unknown) => {
          // Try again next time.
          if (spanCache.peek(key) === entry) spanCache.delete(key);
          throw e;
        },
      ),
    };
    spanCache.set(key, entry);
    return entry;
  };
  /** Load a part of the history in the background, so showing it later is instant. */
  const prefetchSpan = (span: Span) => {
    const range = rangeOf(history(), span);
    if (range === null) return;
    const load = () => loadRange(range).loading.catch(() => {});
    if ("requestIdleCallback" in window) requestIdleCallback(load, { timeout: 500 });
    else setTimeout(load, 50);
  };
  let spanRequest = 0;
  /** Show part of the history (`null`: the whole review). */
  const showSpan = async (next: Span) => {
    const request = ++spanRequest;
    const prev = loadingSpan() ?? span();
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
    // The old view stays up until the new one is ready.
    const entry = loadRange(range);
    let snap = entry.snapshot;
    if (!snap) {
      setLoadingSpan(next);
      try {
        snap = await entry.loading;
      } catch (e) {
        if (request === spanRequest) setLoadingSpan(undefined);
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
    }
    if (request !== spanRequest) return;
    setLoadingSpan(undefined);
    batch(() => {
      setSpan(next);
      setSpanSnapshot(snap);
    });
    events.onSpan?.();
    prefetchSpan(stepAhead(history(), prev, next));
  };
  /** The diff: the whole review, or the part of its history being walked. */
  const diff = createMemo<Snapshot>(() => spanSnapshot() ?? whole());

  // -- The agent's arrangement ---------------------------------------------------------
  // Files can be read group by group, and files with some labels (tests, say) hidden.
  const [layout, setLayout] = createSignal<Layout>(initial.layout);
  // Named before anything renders, then kept up to date.
  setAgentName(initial.layout.agent);
  createEffect(() => setAgentName(layout().agent));
  const arrangeKey = `diffd:hidden-labels:${initial.review.id}`;
  const [hiddenLabels, setHiddenLabels] = createSignal<readonly string[]>(loadJson<string[]>(arrangeKey, []));
  createEffect(() => saveJson(arrangeKey, hiddenLabels()));
  const [grouped, setGrouped] = createSignal(false);
  const labelsFor = (f: FileDiff): string[] => labelsOf(f, layout(), conv.regions);
  /** Every label on the diff's files, with how many files carry it. */
  const labelCounts = createMemo<[string, number][]>(() => {
    const counts = new Map<string, number>();
    for (const f of diff().files) for (const l of labelsFor(f)) counts.set(l, (counts.get(l) ?? 0) + 1);
    return [...counts].sort(([a], [b]) => a.localeCompare(b));
  });
  const groups = createMemo<FileGroup[]>(() =>
    resolveGroups(
      layout(),
      diff().files.map((f) => f.path),
    ),
  );
  let arrangedFrom: Snapshot | null = null;
  /** The diff as it's read: in the agent's groups when reading by group, without hidden files. */
  const arranged = createMemo<Snapshot>((prev) => {
    const base = diff();
    const hide = new Set(hiddenLabels());
    let files =
      hide.size === 0 ? base.files : base.files.filter((f) => !labelsFor(f).some((l) => hide.has(l)));
    if (grouped() && groups().length > 0) {
      const byPath = new Map(files.map((f) => [f.path, f]));
      files = groups().flatMap((g) => g.paths.flatMap((p) => byPath.get(p) ?? []));
    }
    // The same files in the same order: keep the old value, so nothing re-renders.
    const same =
      prev !== undefined &&
      arrangedFrom === base &&
      prev.files.length === files.length &&
      prev.files.every((f, i) => f === files[i]);
    arrangedFrom = base;
    if (same) return prev;
    return files.length === base.files.length && files.every((f, i) => f === base.files[i])
      ? base
      : { ...base, files };
  });
  /** The group starting at each path, when reading by group. */
  const groupStarts = createMemo(() => {
    const starts = new Map<string, FileGroup>();
    if (grouped()) for (const g of groups()) if (g.paths[0]) starts.set(g.paths[0], g);
    return starts;
  });

  // -- Files outside the diff --------------------------------------------------------
  // Opened for context (from the tree, by the agent's `show`, or because a thread is
  // on one). They're appended to the snapshot's files as "unchanged" files, so the
  // cursor, file view, comments and marks all work on them as on any other file.
  const [context, setContext] = createSignal<FileDiff[]>([]);
  const loadingContext = new Map<string, Promise<FileDiff | null>>();
  /** `quiet`: a failure (the file is gone, say) resolves to null without an error on the page. */
  const fetchContext = (path: string, quiet = false): Promise<FileDiff | null> =>
    ok(api.contextFile({ path: { id: initial.review.id }, query: { path } }), `open ${path}`).catch(
      (e: unknown) => {
        if (!quiet) setError(e instanceof Error ? e.message : String(e));
        return null;
      },
    );
  /** Open a file outside the diff; resolves to its index in the snapshot, or null. */
  const openContext = async (path: string, quiet = false): Promise<number | null> => {
    const at = snapshot().files.findIndex((f) => f.path === path);
    if (at >= 0) return at;
    // In the diff but hidden by a label: going to it shows that label's files again.
    const hiddenFile = diff().files.find((f) => f.path === path);
    if (hiddenFile) {
      const mine = labelsFor(hiddenFile);
      setHiddenLabels((h) => h.filter((l) => !mine.includes(l)));
      const shown = snapshot().files.findIndex((f) => f.path === path);
      if (shown >= 0) return shown;
    }
    let pending = loadingContext.get(path);
    if (!pending) {
      pending = fetchContext(path, quiet);
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
    const fresh = await Promise.all(context().map((f) => fetchContext(f.path, true)));
    setContext((c) => c.map((f, i) => fresh[i] ?? f));
  };
  const [repoFiles, setRepoFiles] = createSignal<string[] | null>(null);
  let loadingRepoFiles = false;
  /** Every file in the repository, fetched the first time it's needed. */
  const loadRepoFiles = () => {
    if (repoFiles() !== null || loadingRepoFiles) return;
    loadingRepoFiles = true;
    ok(api.repoFiles({ path: { id: initial.review.id } }), "list the repository's files")
      .then(setRepoFiles)
      .catch(() => setError("Couldn't list the repository's files"))
      .finally(() => {
        loadingRepoFiles = false;
      });
  };

  /** What's on screen: the diff, then any files opened for context. */
  const snapshot = createMemo<Snapshot>(() => {
    const base = arranged();
    const inDiff = new Set(base.files.map((f) => f.path));
    const extra = context().filter((f) => !inDiff.has(f.path));
    return extra.length === 0 ? base : { ...base, files: [...base.files, ...extra] };
  });
  // Threads on files outside the review bring those files in, so the threads have somewhere to show.
  // (Walking commits, threads on files another commit changed just aren't shown.) Quietly: a
  // thread can outlive its file (a generated file renamed, say), and that's no error on every load.
  const triedContext = new Set<string>();
  createEffect(() => {
    const paths = new Set(whole().files.map((f) => f.path));
    for (const t of allThreads()) {
      const path = t.anchor.path;
      if (paths.has(path) || triedContext.has(path)) continue;
      triedContext.add(path);
      void openContext(path, true);
    }
  });
  /** Files in the diff come first in `snapshot().files`; files opened for context follow. */
  const diffCount = () => arranged().files.length;
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
  /** Tests are hidden: their line ranges fold away too. */
  const withTestFolds = createMemo<Region[]>(() =>
    hiddenLabels().includes("test")
      ? [
          ...conv.regions,
          ...conv.regions.flatMap((r) =>
            r.kind === "test" && r.lines !== null ? [{ ...r, kind: "fold" as const, summary: "Tests" }] : [],
          ),
        ]
      : conv.regions,
  );
  const regions = createMemo<Region[]>(() => {
    const snap = spanSnapshot();
    const all = withTestFolds();
    if (!snap) return all;
    return all.flatMap((r) => {
      if (!snap.files.some((f) => f.path === r.path)) return [];
      if (r.lines === null) return [r];
      const [start, end] = r.lines;
      const at = relocate({ path: r.path, side: r.side, start, end, text: r.text, range: null }, snap);
      return at ? [{ ...r, side: at.side, lines: [at.start, at.end] as [number, number] }] : [];
    });
  });
  const chat = createMemo<Message[]>(() => {
    const known = new Set(conv.chat.map((c) => c.id));
    const queued = outbox().flatMap((m) =>
      m.type === "chat" && !known.has(m.messageId) ? [queuedMessage(m.messageId, m.body)] : [],
    );
    return queued.length === 0 ? conv.chat : [...conv.chat, ...queued];
  });

  // By file, so rearranging the files doesn't rebuild every model.
  const modelCache = new WeakMap<FileDiff, FileModel>();
  const modelOf = (f: FileDiff): FileModel => {
    let m = modelCache.get(f);
    if (!m) {
      m = fileModel(f);
      modelCache.set(f, m);
    }
    return m;
  };
  const models = createMemo<FileModel[]>(() => snapshot().files.map(modelOf));
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
      msg.type === "state" ||
      msg.type === "resume" ||
      msg.type === "revision" ||
      msg.type === "thread" ||
      msg.type === "regions" ||
      msg.type === "layout";
    if (moves && events.layout) events.layout(() => applyNow(msg));
    else applyNow(msg);
  };
  /**
   * Everything but the snapshot, as of (re)connecting. Usually nothing
   * changed while the page was away, so only real changes are applied: a
   * reconnect shouldn't re-render anything.
   */
  const catchUp = (state: LiveState) => {
    if (!sameJson(meta(), state.review)) setMeta(state.review);
    followHistory(state.history);
    if (!sameJson(layout(), state.layout)) setLayout(state.layout);
    setConv({
      diagnostics: reconcile(state.diagnostics)(conv.diagnostics),
      threads: reconcile(state.threads, { key: "id" })(conv.threads),
      // A new array would re-render every file's rows; only replace real changes.
      regions: sameJson(conv.regions, state.regions) ? conv.regions : state.regions,
      chat: reconcile(state.chat, { key: "id" })(conv.chat),
      activity: reconcile(state.activity, { key: "seq" })(conv.activity),
      presence: state.presence,
      readSeq: state.readSeq,
    });
  };
  const applyNow = (msg: ServerMsg) =>
    match(msg)
      .with({ type: "state" }, ({ state }) =>
        batch(() => {
          const prev = whole();
          if (state.snapshot.revision !== prev.revision) {
            setWhole(state.snapshot);
            events.onRevision?.(prev, state.snapshot);
            refreshWorktreeSpan();
          }
          catchUp(state);
        }),
      )
      // The server knew we have the current revision, so it left the snapshot out.
      .with({ type: "resume" }, ({ state }) => batch(() => catchUp(state)))
      .with({ type: "revision" }, ({ review, delta }) => {
        const prev = whole();
        const next = applyDelta(prev, delta);
        // Not a change to what we have (we missed one): ask for everything.
        if (next === null) return socket?.resync();
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
      .with({ type: "layout" }, ({ layout: next }) => setLayout(next))
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
    spanCache.deleteWhere((key) => key.endsWith(".."));
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
    socket = connect(initial.review.id, {
      onMessage: apply,
      onStatus: setConnection,
      onOutbox: setOutbox,
      revision: () => whole().revision,
    });
  };
  const send = (msg: ClientMsg) => {
    if (connection() === "gone") setError("This review was deleted; nothing more can be sent.");
    else if (socket) socket.send(msg);
    else setError("Not connected to diffd; this page is a read-only copy.");
  };

  return {
    meta,
    snapshot,
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
    groups,
    /** The group that starts at this path, when reading by group. */
    groupAt: (path: string): FileGroup | undefined => groupStarts().get(path),
    /** Which of the agent's groups (tour chapters) a path is in, or -1. */
    groupOf: (path: string): number => groups().findIndex((g) => g.paths.includes(path)),
    grouped,
    setGrouped,
    labelCounts,
    hiddenLabels,
    /** Show or hide the files with a label. */
    toggleLabel: (label: string) =>
      setHiddenLabels((h) => (h.includes(label) ? h.filter((l) => l !== label) : [...h, label])),
    /** How many of the diff's files are hidden by labels. */
    hiddenCount: () => diff().files.length - arranged().files.length,
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
function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `p${Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("")}`;
}

/** The diff between two points of a review's history. */
function fetchRange(reviewId: string, r: CommitRange): Promise<Snapshot> {
  const query = r.to === null ? { from: r.from } : { from: r.from, to: r.to };
  return ok(api.range({ path: { id: reviewId }, query }), "load those commits");
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A definition (`Symbol` would shadow the global). */
type Definition = Snapshot["symbols"][number];

/**
 * The revision `delta` describes, built on `prev` (which must be its base):
 * files it doesn't carry are `prev`'s very objects, so everything cached per
 * file stays. `null` when `prev` is another revision or lacks a file it needs.
 */
export function applyDelta(prev: Snapshot, delta: SnapshotDelta): Snapshot | null {
  if (prev.revision !== delta.base) return null;
  const before = new Map(prev.files.map((f, i) => [f.path, i]));
  const fresh = new Map(delta.files.map((f) => [f.path, f]));
  const bySource = (symbols: Definition[]) => {
    const map = new Map<number, Definition[]>();
    for (const s of symbols) {
      const list = map.get(s.file);
      if (list) list.push(s);
      else map.set(s.file, [s]);
    }
    return map;
  };
  const oldSymbols = bySource(prev.symbols);
  const newSymbols = bySource(delta.symbols);
  const files: FileDiff[] = [];
  const symbols: Definition[] = [];
  for (const [i, path] of delta.paths.entries()) {
    const f = fresh.get(path);
    if (f) {
      files.push(f);
      symbols.push(...(newSymbols.get(i) ?? []));
      continue;
    }
    const old = before.get(path);
    const kept = old === undefined ? undefined : prev.files[old];
    if (old === undefined || kept === undefined) return null;
    files.push(kept);
    for (const s of oldSymbols.get(old) ?? []) symbols.push(s.file === i ? s : { ...s, file: i });
  }
  return { revision: delta.revision, files, symbols };
}
