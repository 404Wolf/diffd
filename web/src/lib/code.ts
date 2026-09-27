/**
 * Positions in code, the way language servers count them: lines from 1,
 * columns in UTF-16 code units (which is also how JS strings index).
 */
import type { Diagnostic, Severity } from "../api";

/**
 * An identifier in most languages diffd highlights: letters in any script,
 * digits after the first character, `_`, and `$` for JS (`-` excluded).
 */
export const IDENT = /[\p{L}\p{Nl}_$][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}$]*/gu;

export interface WordAt {
  readonly text: string;
  /** Column where the word starts. */
  readonly col: number;
}

/** The identifier covering column `col` of `line`, if any. */
export function wordAt(line: string, col: number): WordAt | null {
  for (const m of line.matchAll(IDENT)) {
    if (m.index <= col && col < m.index + m[0].length) return { text: m[0], col: m.index };
  }
  return null;
}

/** The part of 1-based `line` a diagnostic covers, as `[from, to)` columns, or null. */
export function diagnosticSpan(d: Diagnostic, line: number, length: number): [number, number] | null {
  if (line < d.line || line > d.endLine) return null;
  let from = line === d.line ? d.col : 0;
  let to = line === d.endLine ? d.endCol : length;
  from = Math.min(from, length);
  to = Math.min(Math.max(to, from), length);
  // Zero-width (e.g. "missing semicolon" at a point): mark the character there, or the one before.
  if (from === to) {
    if (to < length) to += 1;
    else if (from > 0) from -= 1;
  }
  return from < to ? [from, to] : null;
}

/** Diagnostics touching 1-based `line`, worst first. */
export function diagnosticsOn(all: readonly Diagnostic[] | undefined, line: number): Diagnostic[] {
  return (all ?? [])
    .filter((d) => line >= d.line && line <= d.endLine)
    .sort((a, b) => rank(a.severity) - rank(b.severity));
}

export function rank(s: Severity): number {
  return { error: 0, warning: 1, info: 2, hint: 3 }[s];
}

/** A DOM Range over columns `[from, to)` of an element's text (walking its text nodes). */
export function textRange(el: Element, from: number, to: number): Range | null {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let at = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const len = node.textContent?.length ?? 0;
    if (!started && from <= at + len) {
      range.setStart(node, from - at);
      started = true;
    }
    if (started && to <= at + len) {
      range.setEnd(node, to - at);
      return range;
    }
    at += len;
  }
  return null;
}

/** The column in an element's text that a point on screen falls on, or null. */
export function columnAtPoint(el: Element, x: number, y: number): number | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | null = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) ({ offsetNode: node, offset } = p);
  } else {
    const r = document.caretRangeFromPoint?.(x, y);
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  }
  if (!node || !el.contains(node)) return null;
  const before = document.createRange();
  before.setStart(el, 0);
  before.setEnd(node, offset);
  return before.toString().length;
}
