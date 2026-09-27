/**
 * Derived, per-file facts about a diff, and the excerpt layout: which rows are
 * shown, which are folded into gaps, and where threads sit.
 */
import type { FileDiff, Region, Side } from "../api";
import { rowChanged } from "./render";

export interface FileModel {
  readonly file: FileDiff;
  /** 1 where a row shows a change. */
  readonly changed: Uint8Array;
  /** Row index for each 0-based old / new line. */
  readonly oldRow: Int32Array;
  readonly newRow: Int32Array;
  /** First row of each run of changed rows. */
  readonly hunks: readonly number[];
}

export function fileModel(file: FileDiff): FileModel {
  const changed = new Uint8Array(file.rows.length);
  const oldRow = new Int32Array(file.old?.lines.length ?? 0).fill(-1);
  const newRow = new Int32Array(file.new?.lines.length ?? 0).fill(-1);
  const hunks: number[] = [];
  file.rows.forEach((row, i) => {
    const c = rowChanged(file, row);
    changed[i] = c ? 1 : 0;
    if (c && (i === 0 || changed[i - 1] === 0)) hunks.push(i);
    if (row[0] !== null) oldRow[row[0]] = i;
    if (row[1] !== null) newRow[row[1]] = i;
  });
  return { file, changed, oldRow, newRow, hunks };
}

/** Row index of a 1-based line on one side, or -1. */
export function rowOf(model: FileModel, side: Side, line: number): number {
  const map = side === "old" ? model.oldRow : model.newRow;
  return map[line - 1] ?? -1;
}

/** Rows shown by default: changes plus `context` lines around them, plus pinned rows. */
export function initialVisible(model: FileModel, context: number, pinned: Iterable<number> = []): Uint8Array {
  const n = model.changed.length;
  const visible = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (model.changed[i] !== 1) continue;
    const from = Math.max(0, i - context);
    const to = Math.min(n - 1, i + context);
    visible.fill(1, from, to + 1);
  }
  for (const p of pinned) if (p >= 0 && p < n) visible[p] = 1;
  return visible;
}

export type Block =
  | { readonly kind: "rows"; readonly start: number; readonly end: number }
  | { readonly kind: "gap"; readonly start: number; readonly end: number }
  | { readonly kind: "after"; readonly row: number };

/**
 * Lay a file out as blocks: runs of visible rows, gaps of hidden rows, and
 * "after" markers where inline content (threads, notes) follows a row.
 * `end` is exclusive.
 */
export function blocks(visible: Uint8Array, breaks: ReadonlySet<number>): Block[] {
  const out: Block[] = [];
  const n = visible.length;
  let i = 0;
  while (i < n) {
    const start = i;
    if (visible[i] === 1) {
      while (i < n && visible[i] === 1) {
        i++;
        if (breaks.has(i - 1)) break;
      }
      out.push({ kind: "rows", start, end: i });
      if (breaks.has(i - 1)) out.push({ kind: "after", row: i - 1 });
    } else {
      while (i < n && visible[i] !== 1) i++;
      out.push({ kind: "gap", start, end: i });
    }
  }
  return out;
}

export type ExpandDirection = "down" | "up" | "all";

/**
 * Reveal part of a gap: `down` grows the code above it, `up` grows the code
 * below it, `all` opens it entirely.
 */
export function expandGap(
  visible: Uint8Array,
  start: number,
  end: number,
  dir: ExpandDirection,
  step: number,
): Uint8Array {
  const next = visible.slice();
  if (dir === "down") next.fill(1, start, Math.min(end, start + step));
  else if (dir === "up") next.fill(1, Math.max(start, end - step), end);
  else next.fill(1, start, end);
  return next;
}

/** The run of visible rows around `row`, as `[start, end)`; empty at a hidden row. */
function visibleRun(visible: Uint8Array, row: number): [number, number] {
  if (visible[row] !== 1) return [row, row];
  let start = row;
  while (start > 0 && visible[start - 1] === 1) start--;
  let end = row + 1;
  while (end < visible.length && visible[end] === 1) end++;
  return [start, end];
}

/**
 * Show `step` more rows on both sides of the visible run around `row` (the
 * hunk the cursor is in): the gap above grows down to it, the gap below up.
 * A hidden `row` opens around itself.
 */
export function growAround(visible: Uint8Array, row: number, step: number): Uint8Array {
  const next = visible.slice();
  const [start, end] = visible[row] === 1 ? visibleRun(visible, row) : [row, row + 1];
  next.fill(1, Math.max(0, start - step), Math.min(visible.length, end + step));
  return next;
}

/**
 * Hide up to `step` rows from each end of the visible run around `row`,
 * never hiding `keep` rows (changes and their context, threads) or `row`.
 */
export function shrinkAround(visible: Uint8Array, row: number, step: number, keep: Uint8Array): Uint8Array {
  const next = visible.slice();
  const [start, end] = visibleRun(visible, row);
  for (let i = start, n = 0; i < row && n < step && keep[i] !== 1; i++, n++) next[i] = 0;
  for (let i = end - 1, n = 0; i > row && n < step && keep[i] !== 1; i--, n++) next[i] = 0;
  return next;
}

/**
 * The gap nearest to `row`, and the direction that grows toward it. Ties go
 * to the gap below.
 */
export function nearestGap(
  visible: Uint8Array,
  row: number,
): { start: number; end: number; dir: ExpandDirection } | null {
  let below: [number, number] | null = null;
  for (let i = row + 1; i < visible.length; i++) {
    if (visible[i] !== 1) {
      let j = i;
      while (j < visible.length && visible[j] !== 1) j++;
      below = [i, j];
      break;
    }
  }
  let above: [number, number] | null = null;
  for (let i = row - 1; i >= 0; i--) {
    if (visible[i] !== 1) {
      let j = i;
      while (j >= 0 && visible[j] !== 1) j--;
      above = [j + 1, i + 1];
      break;
    }
  }
  const distBelow = below ? below[0] - row : Number.POSITIVE_INFINITY;
  const distAbove = above ? row - (above[1] - 1) : Number.POSITIVE_INFINITY;
  if (below && distBelow <= distAbove) return { start: below[0], end: below[1], dir: "down" };
  if (above) return { start: above[0], end: above[1], dir: "up" };
  return null;
}

/** A line nearby that names the enclosing definition, like a hunk header. */
export function gapContext(file: FileDiff, beforeRow: number): string {
  const re =
    /^\s{0,4}(?:pub(?:\([^)]*\))? )?(?:async )?(?:fn|struct|impl|enum|trait|class|def|func|function|interface|type)\b/;
  for (let i = Math.min(beforeRow, file.rows.length - 1); i >= 0; i--) {
    const row = file.rows[i];
    if (!row) continue;
    const text =
      row[1] !== null ? file.new?.lines[row[1]] : row[0] !== null ? file.old?.lines[row[0]] : undefined;
    if (text !== undefined && re.test(text)) return text.trim();
  }
  return "";
}

/** Row indices a region covers in its file (all rows when it has no line range). */
export function regionRows(model: FileModel, region: Region): number[] {
  if (region.lines === null) return model.file.rows.map((_, i) => i);
  const [start, end] = region.lines;
  const rows: number[] = [];
  for (let l = start; l <= end; l++) {
    const r = rowOf(model, region.side, l);
    if (r >= 0) rows.push(r);
  }
  return rows;
}

/** Hide the rows of fold regions, except rows that must stay visible. */
export function applyFolds(
  visible: Uint8Array,
  folds: readonly number[][],
  pinned: ReadonlySet<number>,
): Uint8Array {
  const next = visible.slice();
  for (const rows of folds) for (const r of rows) if (!pinned.has(r)) next[r] = 0;
  return next;
}
