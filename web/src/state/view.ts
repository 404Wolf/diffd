/**
 * Everything about how the review is being looked at, as opposed to what it
 * contains: folds, cursor, mode, drawers, overlays.
 */
import { type Accessor, createEffect, createSignal, on, onCleanup, type Setter, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { match } from "ts-pattern";
import type { Anchor, Diagnostic, ShowRequest, Side, Snapshot, ThreadId } from "../api";
import { applyFolds, carryRow, initialVisible, regionRows, rowOf } from "../lib/diffModel";
import { JumpList } from "../lib/jumps";
import type { Match } from "../lib/search";
import { loadJson, saveJson } from "../lib/storage";
import { setFocusedPane } from "./dom";
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
  /** A line under the query, e.g. how many matches there are. */
  readonly status?: (query: string) => string;
}

/** The last search (`/`, Ctrl+F): what `n` / `N` walk and what's highlighted. */
export interface Search {
  readonly query: string;
  /** The diff it was run on: another revision or commit means searching again. */
  readonly snapshot: Snapshot;
  readonly matches: readonly Match[];
  /** The match last gone to, or -1. */
  readonly index: number;
  /** Searched only this file (the find bar's default). */
  readonly file?: number | undefined;
}

/** One place in the quickfix list. */
export interface QuickItem {
  /** Where, e.g. `lib.rs:45`. */
  readonly label: string;
  /** The line there, or the path. */
  readonly detail: string;
  readonly go: () => void | Promise<void>;
}

/**
 * Places to step through without a popup in the way (vim's quickfix list):
 * references, several definitions. `]q` / `[q` go to the next / previous.
 */
export interface Quickfix {
  readonly title: string;
  readonly items: readonly QuickItem[];
  /** The item last gone to, or -1. */
  readonly index: number;
}

/** The find bar (Ctrl+F): searching the cursor's file, or every file. */
export interface Find {
  readonly scope: "file" | "all";
  /** Opened with `/`: enter goes to the match and closes the bar, like vim. */
  readonly vim?: boolean;
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

/** The files drawer lists the diff's files, or the whole project. */
/** The files drawer: the diff's tree, the whole project, or the agent's groups of related changes. */
export type TreeMode = "diff" | "project" | "groups";

/** Which folders are open in one tree mode: per folder, else `all`, else that mode's default. */
export interface Folders {
  all: boolean | null;
  open: Record<string, boolean>;
}

/** A hover card: a language server's docs and/or the diagnostics at a spot. */
export interface HoverCard {
  /** What it's about, so the same spot isn't asked twice. */
  readonly key: string;
  readonly markdown: string | null;
  readonly diagnostics: readonly Diagnostic[];
  /** Where on screen the hovered word is. */
  readonly at: { readonly left: number; readonly top: number; readonly bottom: number };
}

export interface Drawer {
  size: number;
  collapsed: boolean;
}

interface Flags {
  collapsed: Record<string, boolean>;
  viewed: Record<string, boolean>;
}

export function createView(review: Review) {
  const id = review.meta().id;
  // Per review: one the agent made a tour of starts on the tour; others as you last left the drawer.
  const treeModeKey = `diffd:tree-mode:${id}`;
  const [treeMode, setTreeMode] = createSignal<TreeMode>(
    loadJson<TreeMode | null>(treeModeKey, null) ??
      (review.groups().length > 0 ? "groups" : loadJson<TreeMode>("diffd:tree-mode", "diff")),
  );
  createEffect(
    on(
      treeMode,
      (mode) => {
        saveJson(treeModeKey, mode);
        if (mode !== "groups") saveJson("diffd:tree-mode", mode);
      },
      { defer: true },
    ),
  );
  // Before anything reads the files: they're in the tour's order when reading it.
  review.setGrouped(untrack(treeMode) === "groups");
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
  /**
   * Rows shown for a new snapshot. A file that's the very same object (a
   * revision that didn't touch it) keeps its signal, so nothing about it is
   * laid out again. Whether files moved (and every file must be looked at again).
   */
  const resetVisibility = (prev: Snapshot | null, next: Snapshot): boolean => {
    const keep = new Map<string, Uint8Array>();
    if (prev) {
      prev.files.forEach((f, i) => {
        const sig = visibleSignals[i];
        if (sig && f.rows.length === next.files.find((n) => n.path === f.path)?.rows.length)
          keep.set(f.path, sig[0]());
      });
    }
    const sameFiles =
      prev !== null &&
      prev.files.length === next.files.length &&
      prev.files.every((f, i) => f.path === next.files[i]?.path);
    const old = visibleSignals.slice();
    visibleSignals.length = 0;
    next.files.forEach((f, i) => {
      const sig = sameFiles ? old[i] : undefined;
      if (sig && prev?.files[i] === f) {
        visibleSignals.push(sig);
        return;
      }
      const model = review.models()[i];
      const pinned = pinnedRows(i);
      const saved = prev === null && review.span() === null ? persist.session.visibility[f.path] : undefined;
      const fresh = model
        ? applyFolds(initialVisible(model, CONTEXT, pinned), foldsFor(i, false), new Set(pinned))
        : new Uint8Array();
      // Expanded lines carry over, but on top of the fresh view: an edit that
      // keeps the row count can still change which rows differ, and those must show.
      const kept = keep.get(f.path) ?? (saved ? fromRuns(saved, f.rows.length) : null);
      const initial = kept && kept.length === fresh.length ? fresh.map((v, r) => v | (kept[r] ?? 0)) : fresh;
      if (sig) {
        sig[1](initial);
        visibleSignals.push(sig);
      } else visibleSignals.push(createSignal(initial));
    });
    return !sameFiles;
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
        if (resetVisibility(prev, next)) bumpVisibility((v) => v + 1);
        followFiles(prev, next);
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
    viewed: loadJson(`diffd:viewed:${id}`, {}),
  });
  createEffect(() => saveJson(`diffd:viewed:${id}`, { ...flags.viewed }));
  // Other tabs of this review: viewed files and marks are shared, so take their changes.
  const fromOtherTabs = (e: StorageEvent) => {
    if (e.newValue === null) return;
    try {
      if (e.key === `diffd:viewed:${id}`)
        setFlags("viewed", reconcile(JSON.parse(e.newValue) as Record<string, boolean>));
      if (e.key === `diffd:marks:${id}`) setMarks(reconcile(JSON.parse(e.newValue) as Record<string, Mark>));
    } catch {
      // Another version's data: ignore it.
    }
  };
  window.addEventListener("storage", fromOtherTabs);
  onCleanup(() => window.removeEventListener("storage", fromOtherTabs));
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
  // Tour chapters collapsed in the buffer, by title: only their header shows.
  const [chapters, setChapters] = createStore<Record<string, boolean>>(loadJson(`diffd:chapters:${id}`, {}));
  createEffect(() => saveJson(`diffd:chapters:${id}`, { ...chapters }));
  /** Whether a file is in a collapsed chapter, when reading by chapter. */
  const inClosedChapter = (file: number): boolean => {
    if (!review.grouped()) return false;
    const chapter = review.groups()[review.groupOf(review.snapshot().files[file]?.path ?? "")];
    return chapter !== undefined && Boolean(chapters[chapter.title]);
  };
  const chapterOpen = (title: string): boolean => !chapters[title];
  const setChapterOpen = (title: string, open: boolean) => setChapters(title, !open);
  const hidden = (file: number): boolean => {
    if (review.isContext(file) || inClosedChapter(file)) return true;
    const path = review.snapshot().files[file]?.path ?? "";
    return Boolean(flags.collapsed[path] || flags.viewed[path]);
  };

  // -- Splits ------------------------------------------------------------------------
  // Each pane has its own cursor, mode and jump list; folds and everything else are shared.
  let nextPane = 0;
  const [panes, setPanes] = createSignal<Pane[]>([createPane(nextPane++)]);
  const [focusedId, setFocusedId] = createSignal(0);
  const focused = (): Pane => panes().find((p) => p.id === focusedId()) ?? (panes()[0] as Pane);
  const focusPane = (id: number) => {
    if (id === focusedId() || !panes().some((p) => p.id === id)) return;
    setFocusedId(id);
    setFocusedPane(id);
  };
  /** Split the focused pane to the right; the new pane starts where this one is, and gets focus. */
  const split = (): Pane => {
    const from = focused();
    const pane = createPane(nextPane++, { cursor: from.cursor(), mode: from.mode() });
    const at = panes().indexOf(from);
    setPanes((ps) => [...ps.slice(0, at + 1), pane, ...ps.slice(at + 1)]);
    focusPane(pane.id);
    return pane;
  };
  /** Close the focused pane (never the last one); focus moves to its neighbour. */
  const closePane = (): boolean => {
    const ps = panes();
    if (ps.length < 2) return false;
    const at = ps.indexOf(focused());
    const next = ps[at + 1] ?? ps[at - 1];
    setPanes(ps.filter((_, i) => i !== at));
    if (next) focusPane(next.id);
    return true;
  };
  /**
   * Files are referred to by index; a new revision (or another part of the
   * history) can add, drop or reorder them. Point every pane's cursor, mode,
   * selection and jump list at the same files again, by path.
   */
  const followFiles = (prev: Snapshot, next: Snapshot) => {
    const byPath = new Map(next.files.map((f, i) => [f.path, i]));
    const moved = (file: number): number | null => byPath.get(prev.files[file]?.path ?? "") ?? null;
    /** Row `row` of file `was` (in `prev`), in file `file` of `next`: the same line of code. */
    const rowIn = (was: number, file: number, row: number) => {
      const from = prev.files[was];
      const to = review.models()[file];
      if (from && to) return carryRow(from, to, row);
      return Math.max(0, Math.min(row, (next.files[file]?.rows.length ?? 1) - 1));
    };
    const place = (p: Place): Place | null => {
      const mode: Mode | null = match(p.mode)
        .with({ kind: "diff" }, (m) => m)
        .with({ kind: "file" }, (m) => {
          const file = moved(m.file);
          return file === null ? null : { kind: "file" as const, file };
        })
        .exhaustive();
      const cursorFile = p.cursor ? moved(p.cursor.file) : null;
      const topFile = p.top ? moved(p.top.file) : null;
      if (mode === null) return null;
      return {
        mode,
        cursor:
          p.cursor && cursorFile !== null
            ? { ...p.cursor, file: cursorFile, row: rowIn(p.cursor.file, cursorFile, p.cursor.row) }
            : null,
        top:
          p.top && topFile !== null
            ? { ...p.top, file: topFile, row: rowIn(p.top.file, topFile, p.top.row) }
            : null,
      };
    };
    for (const pane of panes()) {
      const c = pane.cursor();
      const cf = c ? moved(c.file) : null;
      pane.setCursor(c && cf !== null ? { ...c, file: cf, row: rowIn(c.file, cf, c.row), word: null } : null);
      const m = pane.mode();
      if (m.kind === "file") {
        const f = moved(m.file);
        pane.setMode(f === null ? { kind: "diff" } : { kind: "file", file: f });
      }
      const v = pane.visual();
      const vf = v ? moved(v.file) : null;
      pane.setVisual(v && vf !== null ? { file: vf, row: rowIn(v.file, vf, v.row) } : null);
      pane.jumps.remap(place);
      pane.syncJumps();
    }
  };

  const cursor = () => focused().cursor();
  const setCursor = (c: Cursor | null) => focused().setCursor(c);
  const visual = () => focused().visual();
  const setVisual = (v: { file: number; row: number } | null) => focused().setVisual(v);
  const mode = () => focused().mode();
  const setMode = (m: Mode) => focused().setMode(m);
  const [composer, setComposer] = createSignal<Composer | null>(null);
  const [hover, setHover] = createSignal<HoverCard | null>(null);
  const [nudge, setNudge] = createSignal<ShowRequest | null>(null);
  const [selection, setSelection] = createSignal<Selection | null>(null);
  const [picker, setPicker] = createSignal<Picker | null>(null);
  const [search, setSearch] = createSignal<Search | null>(null);
  const [find, setFind] = createSignal<Find | null>(null);
  const [quickfix, setQuickfix] = createSignal<Quickfix | null>(null);
  const [help, setHelp] = createSignal(false);
  const [pending, setPending] = createSignal("");
  const [message, setMessageRaw] = createSignal("");
  const [noteIndex, setNoteIndex] = createSignal(-1);
  const [symKey, setSymKey] = createSignal(false);

  let messageTimer: ReturnType<typeof setTimeout> | undefined;
  const say = (m: string) => {
    setMessageRaw(m);
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => setMessageRaw(""), 3000);
  };

  const [drawers, setDrawers] = createStore(
    loadJson<{ left: Drawer; right: Drawer }>("diffd:drawers", {
      left: { size: 248, collapsed: false },
      right: { size: 250, collapsed: window.innerWidth < 1200 },
    }),
  );
  createEffect(() => saveJson("diffd:drawers", { left: { ...drawers.left }, right: { ...drawers.right } }));
  const [rightTab, setRightTab] = createSignal<RightTab>(loadJson<RightTab>("diffd:right-tab", "activity"));
  createEffect(() => saveJson("diffd:right-tab", rightTab()));
  const [folders, setFolders] = createStore<Record<TreeMode, Folders>>({
    diff: { all: null, open: {} },
    project: { all: null, open: {} },
    groups: { all: null, open: {} },
  });
  // Reading by group puts the files in the agent's order.
  createEffect(() => review.setGrouped(treeMode() === "groups"));
  /**
   * Whether a folder is open. The diff's tree starts open; the project's
   * starts with only the folders holding changes open (`hasChanges`).
   */
  const folderOpen = (mode: TreeMode, path: string, hasChanges: boolean): boolean =>
    folders[mode].open[path] ?? folders[mode].all ?? (mode !== "project" || hasChanges);
  const setFolderOpen = (mode: TreeMode, path: string, open: boolean) => setFolders(mode, "open", path, open);
  /** Open or close every folder of the current tree. */
  const setAllFolders = (open: boolean) => setFolders(treeMode(), { all: open, open: {} });

  const [marks, setMarks] = createStore<Record<string, Mark>>(loadJson(`diffd:marks:${id}`, {}));
  createEffect(() => saveJson(`diffd:marks:${id}`, { ...marks }));

  return {
    persist,
    marks,
    setMarks,
    rightTab,
    setRightTab,
    visible,
    setVisible,
    pinnedRows,
    flags,
    setFlags,
    hidden,
    inClosedChapter,
    chapterOpen,
    setChapterOpen,
    cursor,
    setCursor,
    visual,
    setVisual,
    mode,
    setMode,
    composer,
    setComposer,
    hover,
    setHover,
    nudge,
    setNudge,
    selection,
    setSelection,
    picker,
    setPicker,
    search,
    setSearch,
    find,
    setFind,
    quickfix,
    setQuickfix,
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
    get jumps() {
      return focused().jumps;
    },
    jumpPos: () => focused().jumpPos(),
    syncJumps: () => focused().syncJumps(),
    panes,
    focused,
    focusPane,
    split,
    closePane,
    drawers,
    treeMode,
    setTreeMode,
    folderOpen,
    setFolderOpen,
    setAllFolders,
    setDrawers,
  };
}

export type View = ReturnType<typeof createView>;

/** One side of a split: its own cursor, mode and jump list. */
export interface Pane {
  readonly id: number;
  readonly cursor: Accessor<Cursor | null>;
  readonly setCursor: (c: Cursor | null) => void;
  readonly visual: Accessor<{ file: number; row: number } | null>;
  readonly setVisual: (v: { file: number; row: number } | null) => void;
  readonly mode: Accessor<Mode>;
  readonly setMode: (m: Mode) => void;
  readonly jumps: JumpList<Place>;
  readonly jumpPos: Accessor<JumpList<Place>["position"]>;
  readonly syncJumps: () => void;
}

function createPane(id: number, from: { cursor?: Cursor | null; mode?: Mode } = {}): Pane {
  const [cursor, setCursor] = createSignal<Cursor | null>(from.cursor ?? null);
  const [visual, setVisual] = createSignal<{ file: number; row: number } | null>(null);
  const [mode, setMode] = createSignal<Mode>(from.mode ?? { kind: "diff" });
  const jumps = new JumpList<Place>(
    100,
    (a, b) =>
      JSON.stringify(a.mode) === JSON.stringify(b.mode) &&
      a.cursor?.file === b.cursor?.file &&
      a.cursor?.row === b.cursor?.row,
  );
  const [jumpPos, setJumpPos] = createSignal(jumps.position);
  return {
    id,
    cursor,
    setCursor,
    visual,
    setVisual,
    mode,
    setMode,
    jumps,
    jumpPos,
    syncJumps: () => setJumpPos(jumps.position),
  };
}
