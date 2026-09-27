/**
 * Walking a review's commits: the points you can diff between, and placing
 * threads and regions (anchored in the whole diff) into part of the history.
 */
import type { Anchor } from "../gen/Anchor";
import type { Commit } from "../gen/Commit";
import type { CommitRange } from "../gen/CommitRange";
import type { History } from "../gen/History";
import type { Side } from "../gen/Side";
import type { Snapshot } from "../gen/Snapshot";

/** A point in the history: a commit, or `null` for the working tree. */
export type Point = string | null;

/**
 * What part of the history is shown: `null` for the whole review, otherwise
 * the changes from point `from` to point `to` (indexes into `points`, `from < to`).
 */
export type Span = { readonly from: number; readonly to: number } | null;

/** The base, each commit, then the working tree when the review includes it. */
export function points(h: History): Point[] {
  const out: Point[] = [h.base, ...h.commits.map((c) => c.sha)];
  if (h.worktree) out.push(null);
  return out;
}

/** The steps you can walk one at a time: each commit, then uncommitted changes. */
export function steps(h: History): number {
  return points(h).length - 1;
}

/** The single step `i` (0-based) as a span. */
export const step = (i: number): Span => ({ from: i, to: i + 1 });

/**
 * The step someone walking the history will likely want after `next`: the
 * one past it, in the direction they came from `prev` (forward otherwise).
 * `null` when `next` isn't a single step or there's no step that way.
 */
export function stepAhead(h: History, prev: Span, next: Span): Span {
  if (next === null || next.to - next.from !== 1) return null;
  const back = prev !== null && prev.to - prev.from === 1 && prev.from > next.from;
  const ahead = next.from + (back ? -1 : 1);
  return ahead >= 0 && ahead < steps(h) ? step(ahead) : null;
}

/** The span as revisions the server understands. */
export function rangeOf(h: History, span: Span): CommitRange | null {
  if (span === null) return null;
  const p = points(h);
  const from = p[span.from];
  const to = p[span.to];
  if (from === undefined || from === null || to === undefined) return null;
  return { from, to };
}

/** Find the same span again after the history changed (commits added or rewritten). */
export function carrySpan(before: History, after: History, span: Span): Span {
  if (span === null) return null;
  const range = rangeOf(before, span);
  if (!range) return null;
  const p = points(after);
  const from = p.indexOf(range.from);
  const to = p.indexOf(range.to);
  return from >= 0 && to > from ? { from, to } : null;
}

/** The commits a span covers, oldest first; `uncommitted` when it reaches the working tree. */
export function spanCommits(h: History, span: Span): { commits: Commit[]; uncommitted: boolean } {
  if (span === null) return { commits: h.commits, uncommitted: h.worktree };
  const commits = h.commits.slice(span.from, Math.min(span.to, h.commits.length));
  return { commits, uncommitted: h.worktree && span.to === points(h).length - 1 };
}

/** A short label for what's shown, e.g. `a1b2c3d`, `a1b2c3d..e4f5a6b`, `uncommitted`. */
export function spanLabel(h: History, span: Span): string {
  if (span === null) return "All changes";
  const { commits, uncommitted } = spanCommits(h, span);
  const first = commits[0];
  const last = commits.at(-1);
  if (!first || !last) return uncommitted ? "Uncommitted changes" : "";
  const shas = first === last ? first.short : `${first.short}..${last.short}`;
  return uncommitted ? `${shas} + uncommitted` : shas;
}

/**
 * Find `text` (one or more lines) in `lines`, nearest to `start` (1-based).
 * Returns the 1-based line where it starts, or null.
 */
export function locate(text: string, start: number, lines: readonly string[]): number | null {
  const want = text.split("\n");
  const n = want.length;
  let best: number | null = null;
  for (let i = 0; i + n <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < n && ok; k++) ok = lines[i + k] === want[k];
    if (ok && (best === null || Math.abs(i + 1 - start) < Math.abs(best - start))) best = i + 1;
  }
  return best;
}

/** Place an anchor into another snapshot by its text: its own side first, then the other. */
export function relocate(anchor: Anchor, snap: Snapshot): Anchor | null {
  if (!anchor.text) return null;
  const file = snap.files.find((f) => f.path === anchor.path);
  if (!file) return null;
  const sides: Side[] = anchor.side === "new" ? ["new", "old"] : ["old", "new"];
  for (const side of sides) {
    const text = side === "new" ? file.new : file.old;
    if (!text) continue;
    const at = locate(anchor.text, anchor.start, text.lines);
    if (at !== null) return { ...anchor, side, start: at, end: at + (anchor.end - anchor.start) };
  }
  return null;
}
