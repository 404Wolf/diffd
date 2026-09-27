/**
 * Everything about how the review is being looked at, as opposed to what it
 * contains: folds, cursor, mode, drawers, overlays.
 */
import { type Accessor, createEffect, createSignal, on, type Setter } from "solid-js";
import { createStore } from "solid-js/store";
import type { Anchor } from "../gen/Anchor";
import type { ShowRequest } from "../gen/ShowRequest";
import type { Side } from "../gen/Side";
import type { Snapshot } from "../gen/Snapshot";
import type { ThreadId } from "../gen/ThreadId";
import { applyFolds, initialVisible, regionRows, rowOf } from "../lib/diffModel";
import { JumpList } from "../lib/jumps";
import { fromRuns, loadSession, sessionWriter, toRuns } from "./persist";
import type { Review } from "./review";

/** Lines of context around each change. */
export const CONTEXT = 3;
/** Lines revealed per expand step. */
export const EXPAND_STEP = 5;

export interface Word {
  readonly text: string;
  readonly range: readonly [number, number];
}

export interface Cursor {
  readonly file: number;
  readonly row: number;
  readonly side: Side;
  readonly word: Word | null;
}

export type Mode = { readonly kind: "diff" } | { readonly kind: "file"; readonly file: number };

export type Composer =
  | { readonly kind: "new"; readonly anchor: Anchor; readonly quote: string }
  | { readonly kind: "reply"; readonly threadId: ThreadId; readonly label: string };

export interface PickerItem {
  readonly label: string;
  readonly detail: string;
  readonly run: () => void;
}

export interface Picker {
  readonly title: string;
  /** Items for a query; `literal` pickers filter themselves instead of fuzzy matching. */
  readonly items: (query: string) => readonly PickerItem[];
  readonly literal?: boolean;
}

/** Lines picked with the mouse, waiting to be commented on. */
export interface Selection {
  readonly file: number;
  readonly side: Side;
  readonly start: number;
  readonly end: number;
  /** Where to show the "Comment" button, relative to the diff container. */
  readonly top: number;
  readonly left: number;
}

export interface Place {
  readonly mode: Mode;
  readonly cursor: Cursor | null;
  /** The row at the top of the screen and its offset from the buffer's top edge. */
  readonly top: { readonly file: number; readonly row: number; readonly offset: number } | null;
}

/** A vim mark: a line you can come back to with `'` or `` ` ``. */
export interface Mark {
  readonly path: string;
  readonly side: Side;
  /** 1-based. */
  readonly line: number;
  /** The line's code when the mark was set, for the marks list. */
  readonly text: string;
}

export type RightTab = "activity" | "commits";

export interface Drawer {
  size: number;
  collapsed: boolean;
}

interface Flags {
  collapsed: Record<string, boolean>;
  viewed: Record<string, boolean>;
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Unavailable storage just means preferences don't persist.
  }
}

export function createView(review: Review) {
  const id = review.meta().id;
  const persist = sessionWriter(id, loadSession(id));
  /** Expanded lines are remembered for the whole review, not for walks through its commits. */
  const rememberVisible = (file: number, v: Uint8Array) => {
    const path = review.snapshot().files[file]?.path;
    if (path === undefined || review.span() !== null) return;
    persist.update((s) => {
      s.visibility[path] = { rows: v.length, runs: toRuns(v) };
    });
  };

  // Rows shown per file. Files whose rows didn't change across a revision keep their folds.
  const visibleSignals: [Accessor<Uint8Array>, Setter<Uint8Array>][] = [];
  const pinnedRows = (file: number): number[] =>
    review.threads().flatMap((t) => {
      if (t.anchor.path !== review.snapshot().files[file]?.path) return [];
      const model = review.models()[file];
      if (!model) return [];
      const rows: number[] = [];
      for (let l = t.anchor.start; l <= t.anchor.end; l++) rows.push(rowOf(model, t.anchor.side, l));
      return rows;
    });
  /** Folds applied so far (by region key), so each fold hides its rows once. */
  const appliedFolds = new Set<string>();
  const foldKey = (r: { path: string; lines: [number, number] | null; summary: string | null }) =>
    `${r.path}:${r.lines?.join("-")}:${r.summary}`;
  const foldsFor = (file: number, onlyNew: boolean): number[][] => {
    const model = review.models()[file];
    const path = review.snapshot().files[file]?.path;
    if (!model) return [];
    return review
      .regions()
      .filter((r) => r.kind === "fold" && r.path === path && (!onlyNew || !appliedFolds.has(foldKey(r))))
      .map((r) => regionRows(model, r));
  };
  const markFoldsApplied = () => {
    for (const r of review.regions()) if (r.kind === "fold") appliedFolds.add(foldKey(r));
  };
  const resetVisibility = (prev: Snapshot | null, next: Snapshot) => {
    const keep = new Map<string, Uint8Array>();
    if (prev) {
      prev.files.forEach((f, i) => {
        const sig = visibleSignals[i];
        if (sig && f.rows.length === next.files.find((n) => n.path === f.path)?.rows.length)
          keep.set(f.path, sig[0]());
      });
    }
    visibleSignals.length = 0;
    next.files.forEach((f, i) => {
      const model = review.models()[i];
      const pinned = pinnedRows(i);
      const saved = prev === null && review.span() === null ? persist.session.visibility[f.path] : undefined;
      const initial =
        keep.get(f.path) ??
        (saved ? fromRuns(saved, f.rows.length) : null) ??
        (model
          ? applyFolds(initialVisible(model, CONTEXT, pinned), foldsFor(i, false), new Set(pinned))
          : new Uint8Array());
      visibleSignals.push(createSignal(initial));
    });
  };
  resetVisibility(null, review.snapshot());
  markFoldsApplied();
  // Folds the agent adds later hide their rows once, as they arrive.
  createEffect(
    on(
      () => review.regions(),
      () => {
        review.snapshot().files.forEach((_, i) => {
          const folds = foldsFor(i, true);
          const sig = visibleSignals[i];
          if (folds.length && sig) setVisible(i, applyFolds(sig[0](), folds, new Set(pinnedRows(i))));
        });
        markFoldsApplied();
      },
      { defer: true },
    ),
  );
  const [visibilityVersion, bumpVisibility] = createSignal(0);
  createEffect(
    on(review.snapshot, (next, prev) => {
      if (prev) {
        resetVisibility(prev, next);
        bumpVisibility((v) => v + 1);
      }
    }),
  );
  const visible = (file: number): Uint8Array => {
    visibilityVersion();
    return visibleSignals[file]?.[0]() ?? new Uint8Array();
  };
  const setVisible = (file: number, v: Uint8Array) => {
    visibleSignals[file]?.[1](v);
    rememberVisible(file, v);
  };

  const [flags, setFlags] = createStore<Flags>({
    collapsed: {
      ...Object.fromEntries(
        review
          .snapshot()
          .files.filter((f) => f.collapsed)
          .map((f) => [f.path, true]),
      ),
      ...persist.session.collapsed,
    },
    viewed: load(`diffd:viewed:${id}`, {}),
  });
  createEffect(() => save(`diffd:viewed:${id}`, { ...flags.viewed }));
  createEffect(() => {
    const collapsed = { ...flags.collapsed };
    persist.update((s) => {
      s.collapsed = collapsed;
    });
  });
  // Files the agent asked to collapse start collapsed in every part of the history too.
  createEffect(
    on(review.snapshot, (snap) => {
      for (const f of snap.files)
        if (f.collapsed && !(f.path in flags.collapsed)) setFlags("collapsed", f.path, true);
    }),
  );
  const hidden = (file: number): boolean => {
    const path = review.snapshot().files[file]?.path ?? "";
    return Boolean(flags.collapsed[path] || flags.viewed[path]);
  };

  const [cursor, setCursor] = createSignal<Cursor | null>(null);
  const [visual, setVisual] = createSignal<{ file: number; row: number } | null>(null);
  const [mode, setMode] = createSignal<Mode>({ kind: "diff" });
  const [composer, setComposer] = createSignal<Composer | null>(null);
  const [nudge, setNudge] = createSignal<ShowRequest | null>(null);
  const [selection, setSelection] = createSignal<Selection | null>(null);
  const [picker, setPicker] = createSignal<Picker | null>(null);
  const [help, setHelp] = createSignal(false);
  const [pending, setPending] = createSignal("");
  const [message, setMessageRaw] = createSignal("");
  const [noteIndex, setNoteIndex] = createSignal(-1);
  const [symKey, setSymKey] = createSignal(false);
  const jumps = new JumpList<Place>();
  const [jumpPos, setJumpPos] = createSignal(jumps.position);

  let messageTimer: ReturnType<typeof setTimeout> | undefined;
  const say = (m: string) => {
    setMessageRaw(m);
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => setMessageRaw(""), 3000);
  };

  const [drawers, setDrawers] = createStore(
    load<{ left: Drawer; right: Drawer }>("diffd:drawers", {
      left: { size: 248, collapsed: false },
      right: { size: 250, collapsed: window.innerWidth < 1200 },
    }),
  );
  createEffect(() => save("diffd:drawers", { left: { ...drawers.left }, right: { ...drawers.right } }));
  const [rightTab, setRightTab] = createSignal<RightTab>(load<RightTab>("diffd:right-tab", "activity"));
  createEffect(() => save("diffd:right-tab", rightTab()));

  const [marks, setMarks] = createStore<Record<string, Mark>>(load(`diffd:marks:${id}`, {}));
  createEffect(() => save(`diffd:marks:${id}`, { ...marks }));

  return {
    persist,
    marks,
    setMarks,
    rightTab,
    setRightTab,
    visible,
    setVisible,
    flags,
    setFlags,
    hidden,
    cursor,
    setCursor,
    visual,
    setVisual,
    mode,
    setMode,
    composer,
    setComposer,
    nudge,
    setNudge,
    selection,
    setSelection,
    picker,
    setPicker,
    help,
    setHelp,
    pending,
    setPending,
    message,
    say,
    noteIndex,
    setNoteIndex,
    symKey,
    setSymKey,
    jumps,
    jumpPos,
    syncJumps: () => setJumpPos(jumps.position),
    drawers,
    setDrawers,
  };
}

export type View = ReturnType<typeof createView>;
