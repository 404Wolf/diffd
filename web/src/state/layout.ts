/**
 * What a pane shows, as one flat list of items. The multibuffer: each file's
 * header, its rows, the gaps between excerpts, thread cards and the file's
 * end. File view: one file's rows and its threads. The windowed buffer
 * renders only the items near the viewport, so everything that moves through
 * rows (the cursor, `]c`, `]f`, `G`, the status line) works on these lists,
 * not the DOM.
 *
 * Each file's items are built by their own memo and keep their identities
 * across rebuilds, so expanding a gap in one file touches only that file's
 * items and a rendered item stays rendered.
 */

import { type Accessor, createMemo, createRoot } from "solid-js";
import type { Side } from "../gen/Side";
import type { Thread } from "../gen/Thread";
import { blocks, regionRows, rowOf } from "../lib/diffModel";
import type { RowMarks } from "../lib/render";
import type { Review } from "./review";
import type { View } from "./view";

export type Item =
  | { readonly kind: "summary" }
  /** The agent's group of related changes that starts with this file, when reading by group. */
  | { readonly kind: "group"; readonly file: number }
  | { readonly kind: "head"; readonly file: number }
  /** What the file shows instead of, or above, its rows. */
  | { readonly kind: "notice"; readonly file: number; readonly what: "details" | "omitted" | "collapsed" }
  | { readonly kind: "row"; readonly file: number; readonly row: number }
  | { readonly kind: "gap"; readonly file: number; readonly start: number; readonly end: number }
  | { readonly kind: "threads"; readonly file: number; readonly row: number }
  /** The bottom edge of the file's card. */
  | { readonly kind: "end"; readonly file: number };

export type RowItem = Extract<Item, { kind: "row" }>;

interface FileLayout {
  readonly items: readonly Item[];
  /** Each row's index in `items`, or -1 where it's folded away. */
  readonly rowItem: Int32Array;
}

export interface Layout {
  readonly items: readonly Item[];
  /** Where each file's items start in `items`; one more entry than files. */
  readonly fileStart: Int32Array;
  /** Indices of the row items, in order: what the cursor moves through. */
  readonly rows: Int32Array;
  /** Indices of rows that start a run of changes. */
  readonly hunks: Int32Array;
}

/** What commands and the window need from a list, whichever list a pane shows. */
export interface ListNav {
  readonly layout: Accessor<Layout>;
  /** Where a row is in the list, or -1 when it isn't shown. */
  indexOfRow(file: number, row: number): number;
  /** Where an item from an earlier layout is now: itself, or the nearest thing that took its place. */
  relocate(item: Item): number;
  /** Where a file's header is. */
  headIndex(file: number): number;
  /** Position in `rows` of the row item at or before `index`. */
  rowPositionAt(index: number): number;
  /** The row item `delta` rows from the item at `index` (clamped to the ends). */
  stepRow(index: number, delta: number): RowItem | null;
  /** The threads shown under a row. */
  threadsAt(file: number, row: number): readonly Thread[];
}

/** The parts of `ListNav` that are the same for every list. */
function listNav(
  layout: Accessor<Layout>,
  own: Pick<ListNav, "indexOfRow" | "relocate" | "headIndex" | "threadsAt">,
): ListNav {
  const rowPositionAt = (index: number): number => {
    const rows = layout().rows;
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((rows[mid] as number) <= index) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  };
  const stepRow = (index: number, delta: number): RowItem | null => {
    const rows = layout().rows;
    if (rows.length === 0) return null;
    const at = index < 0 ? (delta > 0 ? -1 : rows.length) : rowPositionAt(index);
    const pos = Math.max(0, Math.min(rows.length - 1, at + delta));
    return layout().items[rows[pos] as number] as RowItem;
  };
  return { layout, ...own, rowPositionAt, stepRow };
}

/** Per-file facts the row renderer and the items need, each a memo. */
interface FileState {
  readonly layout: Accessor<FileLayout>;
  readonly marks: Accessor<RowMarks>;
  readonly threadsByRow: Accessor<Map<number, Thread[]>>;
}

export function createLayout(review: Review, view: View) {
  const hasSummary = () =>
    Boolean(review.meta().summary) || review.notes().length > 0 || review.groups().length > 0;
  const summaryItem: Item = { kind: "summary" };

  const fileState = (index: number): FileState => {
    const file = () => review.snapshot().files[index];
    const model = () => review.models()[index];

    // Unchanged unless this file's threads change: a comment elsewhere doesn't lay this file out again.
    const threadsByRow = createMemo(
      () => {
        const byRow = new Map<number, Thread[]>();
        const f = file();
        const m = model();
        if (!f || !m) return byRow;
        for (const t of review.threads()) {
          if (t.anchor.path !== f.path) continue;
          const row = rowOf(m, t.anchor.side, t.anchor.end);
          if (row >= 0) byRow.set(row, [...(byRow.get(row) ?? []), t]);
        }
        return byRow;
      },
      undefined,
      {
        equals: (a, b) =>
          a.size === b.size &&
          [...a].every(([row, ts]) => {
            const other = b.get(row);
            return other?.length === ts.length && ts.every((t, i) => t === other[i]);
          }),
      },
    );

    const tests = createMemo(
      () => {
        const m = model();
        const rows = new Set<number>();
        if (m)
          for (const r of review.regions())
            if (r.kind === "test" && r.path === m.file.path) for (const i of regionRows(m, r)) rows.add(i);
        return rows;
      },
      undefined,
      { equals: sameSet },
    );
    const noted = createMemo(
      () => {
        const lines = new Set<number>();
        const path = file()?.path;
        for (const t of review.notes())
          if (t.anchor.path === path && t.anchor.side === "new")
            for (let l = t.anchor.start; l <= t.anchor.end; l++) lines.add(l);
        return lines;
      },
      undefined,
      { equals: sameSet },
    );
    const named = createMemo(
      () => {
        const byLine = new Map<string, string>();
        const path = file()?.path;
        for (const [name, m] of Object.entries(view.marks))
          if (m.path === path) byLine.set(`${m.side}:${m.line}`, name);
        return byLine;
      },
      undefined,
      { equals: (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v) },
    );
    const marks = createMemo<RowMarks>(() => ({
      noted: noted(),
      since: new Set(file()?.since ?? []),
      refs: review.definedNames(),
      tests: tests(),
      named: named(),
    }));

    // Items keep their identity across rebuilds (by key), so rendered ones stay rendered.
    let cache = new Map<string, Item>();
    const layout = createMemo<FileLayout>(() => {
      const f = file();
      const rowItem = new Int32Array(f?.rows.length ?? 0).fill(-1);
      if (!f || review.isContext(index)) return { items: [], rowItem };
      const next = new Map<string, Item>();
      const items: Item[] = [];
      const add = (key: string, make: () => Item) => {
        const item = cache.get(key) ?? make();
        next.set(key, item);
        items.push(item);
      };
      if (review.groupAt(f.path)) add("group", () => ({ kind: "group", file: index }));
      add("head", () => ({ kind: "head", file: index }));
      if (view.hidden(index)) {
        if (f.collapsed && !view.flags.viewed[f.path])
          add("collapsed", () => ({ kind: "notice", file: index, what: "collapsed" }));
      } else {
        if (f.details.length > 0) add("details", () => ({ kind: "notice", file: index, what: "details" }));
        if (f.omitted !== null) add("omitted", () => ({ kind: "notice", file: index, what: "omitted" }));
        else
          for (const b of blocks(view.visible(index), new Set(threadsByRow().keys()))) {
            if (b.kind === "rows")
              for (let r = b.start; r < b.end; r++) {
                rowItem[r] = items.length;
                add(`r${r}`, () => ({ kind: "row", file: index, row: r }));
              }
            else if (b.kind === "gap")
              add(`g${b.start}:${b.end}`, () => ({ kind: "gap", file: index, start: b.start, end: b.end }));
            else add(`t${b.row}`, () => ({ kind: "threads", file: index, row: b.row }));
          }
      }
      add("end", () => ({ kind: "end", file: index }));
      cache = next;
      return { items, rowItem };
    });
    return { layout, marks, threadsByRow };
  };

  /** Per-file memos, rebuilt when the snapshot changes (a revision, another part of the history). */
  const perFile = createMemo<{ states: FileState[]; dispose: () => void }>((prev) => {
    prev?.dispose();
    const count = review.snapshot().files.length;
    return createRoot((dispose) => ({
      states: Array.from({ length: count }, (_, i) => fileState(i)),
      dispose,
    }));
  });

  const layout = createMemo<Layout>(() => {
    const states = perFile().states;
    const items: Item[] = hasSummary() ? [summaryItem] : [];
    const fileStart = new Int32Array(states.length + 1);
    const rows: number[] = [];
    const hunks: number[] = [];
    states.forEach((s, file) => {
      fileStart[file] = items.length;
      const model = review.models()[file];
      let prevChanged = false;
      for (const item of s.layout().items) {
        if (item.kind === "row") {
          const changed = model?.changed[item.row] === 1;
          if (changed && !prevChanged) hunks.push(items.length);
          prevChanged = changed;
          rows.push(items.length);
        }
        items.push(item);
      }
    });
    fileStart[states.length] = items.length;
    return { items, fileStart, rows: Int32Array.from(rows), hunks: Int32Array.from(hunks) };
  });

  const state = (file: number): FileState | undefined => perFile().states[file];

  /** Where a row is in the list, or -1 when it isn't shown (folded, or its file is collapsed). */
  const indexOfRow = (file: number, row: number): number => {
    const local = state(file)?.layout().rowItem[row] ?? -1;
    return local < 0 ? -1 : (layout().fileStart[file] ?? 0) + local;
  };

  /** Where an item from an earlier layout is now: itself, or the nearest thing that took its place. */
  const relocate = (item: Item): number => {
    const l = layout();
    if (item.kind === "summary") return l.items[0] === item ? 0 : -1;
    if (item.kind === "row") {
      const at = indexOfRow(item.file, item.row);
      if (at >= 0) return at;
    }
    const start = l.fileStart[item.file] ?? -1;
    const own = state(item.file)?.layout().items.indexOf(item) ?? -1;
    if (own >= 0) return start + own;
    // Gone (folded away, or the file collapsed): the file's header stands in.
    const head = headIndex(item.file);
    return head < l.items.length ? head : -1;
  };

  /** Where a file's header is: its first item, after its group's header if it starts one. */
  const headIndex = (file: number): number => {
    const l = layout();
    const start = l.fileStart[file] ?? l.items.length;
    return l.items[start]?.kind === "group" ? start + 1 : start;
  };

  return {
    ...listNav(layout, {
      indexOfRow,
      relocate,
      headIndex,
      threadsAt: (file: number, row: number): readonly Thread[] => state(file)?.threadsByRow().get(row) ?? [],
    }),
    marks: (file: number): RowMarks | undefined => state(file)?.marks(),
    hasSummary,
  };
}

export type LayoutState = ReturnType<typeof createLayout>;

/**
 * File view (`g enter`) as a list: the rows of one side of one file, each
 * followed by the threads that end on it.
 */
export function createFileLayout(review: Review, file: Accessor<number>): ListNav & { side: Accessor<Side> } {
  const diff = () => review.snapshot().files[file()];
  /** The side shown: the new file, or the old one when the file was deleted. */
  const side = (): Side => (diff()?.new ? "new" : "old");
  const threadsByRow = createMemo(() => {
    const f = diff();
    const model = review.models()[file()];
    const byRow = new Map<number, Thread[]>();
    if (!f || !model) return byRow;
    for (const t of review.threads()) {
      if (t.anchor.path !== f.path || t.anchor.side !== side()) continue;
      const row = rowOf(model, t.anchor.side, t.anchor.end);
      if (row >= 0) byRow.set(row, [...(byRow.get(row) ?? []), t]);
    }
    return byRow;
  });
  let cache = new Map<string, Item>();
  const built = createMemo(() => {
    const f = diff();
    const index = file();
    const rowItem = new Int32Array(f?.rows.length ?? 0).fill(-1);
    const items: Item[] = [];
    const rows: number[] = [];
    const next = new Map<string, Item>();
    const add = (key: string, make: () => Item) => {
      const item = cache.get(key) ?? make();
      next.set(key, item);
      items.push(item);
    };
    const s = side();
    f?.rows.forEach((r, i) => {
      if ((s === "new" ? r[1] : r[0]) === null) return;
      rowItem[i] = items.length;
      rows.push(items.length);
      add(`${index}:r${i}`, () => ({ kind: "row", file: index, row: i }));
      if (threadsByRow().has(i)) add(`${index}:t${i}`, () => ({ kind: "threads", file: index, row: i }));
    });
    cache = next;
    // Every file's items "start" here: the file's at 0, the files after it at the end.
    const count = review.snapshot().files.length;
    const fileStart = Int32Array.from({ length: count + 1 }, (_, k) => (k > index ? items.length : 0));
    const layout: Layout = { items, fileStart, rows: Int32Array.from(rows), hunks: new Int32Array() };
    return { layout, rowItem };
  });
  const layout = () => built().layout;
  const indexOfRow = (f: number, row: number) => (f === file() ? (built().rowItem[row] ?? -1) : -1);
  return {
    ...listNav(layout, {
      indexOfRow,
      relocate: (item) => {
        if (item.kind === "row") return indexOfRow(item.file, item.row);
        const at = layout().items.indexOf(item);
        return at >= 0 ? at : 0;
      },
      headIndex: () => 0,
      threadsAt: (f, row) => (f === file() ? (threadsByRow().get(row) ?? []) : []),
    }),
    side,
  };
}

function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}
