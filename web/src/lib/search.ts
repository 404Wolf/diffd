/**
 * The page's own find (`/`, Ctrl+F): every occurrence of a string in both
 * sides of every file, folded lines too. The diff is windowed, so the
 * browser's find could only see the rows near the screen.
 */

import type { FileDiff, Side } from "../api";
import type { FileModel } from "./diffModel";

export interface Match {
  readonly file: number;
  /** The row it's on, and where on that side's line (0-based columns). */
  readonly row: number;
  readonly side: Side;
  /** 1-based. */
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

/** A place in the multibuffer's order: file, row, then old before new, then column. */
export interface Place {
  readonly file: number;
  readonly row: number;
  readonly side: Side;
  readonly col: number;
}

/** Stop counting here: a search this broad isn't worth walking. */
export const MAX_MATCHES = 50_000;

/**
 * Every case-insensitive occurrence of `query`, in the order the
 * multibuffer shows them (files in order, then rows, old side before new).
 */
export function findMatches(
  files: readonly FileDiff[],
  models: readonly FileModel[],
  query: string,
  /** Only this file (the find bar's default), or every file. */
  only?: number,
): Match[] {
  const needle = query.toLowerCase();
  const out: Match[] = [];
  if (needle.length === 0) return out;
  files.forEach((f, file) => {
    if (only !== undefined && file !== only) return;
    const model = models[file];
    if (!model) return;
    const found: Match[] = [];
    for (const [side, text, rowOfLine] of [
      ["old", f.old, model.oldRow],
      ["new", f.new, model.newRow],
    ] as const) {
      text?.lines.forEach((l, i) => {
        if (out.length + found.length >= MAX_MATCHES) return;
        const lower = l.toLowerCase();
        for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length))
          found.push({
            file,
            row: rowOfLine[i] ?? -1,
            side,
            line: i + 1,
            start: at,
            end: at + needle.length,
          });
      });
    }
    found.sort(compare);
    out.push(...found);
  });
  return out;
}

function compare(a: Place | Match, b: Place | Match): number {
  const col = (p: Place | Match) => ("col" in p ? p.col : p.start);
  return a.file - b.file || a.row - b.row || sideOrder(a.side) - sideOrder(b.side) || col(a) - col(b);
}
const sideOrder = (s: Side) => (s === "old" ? 0 : 1);

/**
 * The match after (or before) a place, wrapping around the ends; its index,
 * and whether it wrapped. -1 when there are none.
 */
export function nextMatch(
  matches: readonly Match[],
  from: Place,
  dir: 1 | -1,
): { readonly index: number; readonly wrapped: boolean } {
  if (matches.length === 0) return { index: -1, wrapped: false };
  // The first match after `from`, by binary search.
  let lo = 0;
  let hi = matches.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compare(matches[mid] as Match, from) <= 0) lo = mid + 1;
    else hi = mid;
  }
  if (dir > 0) return lo < matches.length ? { index: lo, wrapped: false } : { index: 0, wrapped: true };
  // Before `from`: skip a match exactly at it.
  let before = lo - 1;
  while (before >= 0 && compare(matches[before] as Match, from) === 0) before--;
  return before >= 0 ? { index: before, wrapped: false } : { index: matches.length - 1, wrapped: true };
}

/** Where `needle` occurs in `text`, case-insensitively, as [start, end) pairs. */
export function occurrences(text: string, needle: string): [number, number][] {
  const out: [number, number][] = [];
  if (!needle) return out;
  const lower = text.toLowerCase();
  const n = needle.toLowerCase();
  for (let at = lower.indexOf(n); at >= 0; at = lower.indexOf(n, at + n.length))
    out.push([at, at + n.length]);
  return out;
}
