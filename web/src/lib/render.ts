/**
 * Building diff rows as HTML strings. The browser's parser is the fastest way
 * to create large amounts of DOM, and the rows never change once built, so
 * the diff body is plain HTML while everything around it is Solid.
 */
import type { FileDiff } from "../gen/FileDiff";
import type { Row } from "../gen/Row";
import type { SideText } from "../gen/SideText";
import { SYNTAX_CLASSES } from "../gen/syntaxClasses";

export type Range = readonly [start: number, end: number];

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ESCAPES[c] ?? c);

const IDENT = /[A-Za-z_$][\w$]*/g;

export interface LineOptions {
  /** Class for novel tokens (`nv-add` / `nv-del`), or null to ignore novelty. */
  readonly novelClass: string | null;
  /** The symbol-mode cursor, if it's on this line. */
  readonly word?: Range | undefined;
  /** Names with a definition; occurrences get the `ref` class. */
  readonly refs?: ReadonlySet<string> | undefined;
}

/**
 * One line as HTML: syntax classes, novel-token emphasis, symbol refs and the
 * word cursor, flattened into non-overlapping spans.
 */
export function lineHtml(
  text: string,
  syntax: readonly number[] | undefined,
  novel: readonly number[] | undefined,
  opts: LineOptions,
): string {
  if (text.length === 0) return "";
  const cuts = new Set<number>([0, text.length]);
  const runs = syntax ?? [];
  for (let i = 0; i + 2 < runs.length; i += 3) {
    cuts.add(runs[i] as number);
    cuts.add(runs[i + 1] as number);
  }
  const nov = opts.novelClass ? (novel ?? []) : [];
  for (const n of nov) cuts.add(n);
  const refs: number[] = [];
  if (opts.refs && opts.refs.size > 0) {
    for (const m of text.matchAll(IDENT)) {
      if (opts.refs.has(m[0])) refs.push(m.index, m.index + m[0].length);
    }
    for (const r of refs) cuts.add(r);
  }
  if (opts.word) {
    cuts.add(opts.word[0]);
    cuts.add(opts.word[1]);
  }
  const points = [...cuts].filter((p) => p >= 0 && p <= text.length).sort((a, b) => a - b);

  let html = "";
  let si = 0;
  let ni = 0;
  let ri = 0;
  for (let p = 0; p + 1 < points.length; p++) {
    const a = points[p] as number;
    const b = points[p + 1] as number;
    while (si + 2 < runs.length && (runs[si + 1] as number) <= a) si += 3;
    while (ni + 1 < nov.length && (nov[ni + 1] as number) <= a) ni += 2;
    while (ri + 1 < refs.length && (refs[ri + 1] as number) <= a) ri += 2;
    const segment = text.slice(a, b);
    const classes: string[] = [];
    if (si + 2 < runs.length && (runs[si] as number) <= a && b <= (runs[si + 1] as number)) {
      const name = SYNTAX_CLASSES[runs[si + 2] as number];
      if (name) classes.push(`s-${name}`);
    }
    if (
      ni + 1 < nov.length &&
      (nov[ni] as number) <= a &&
      b <= (nov[ni + 1] as number) &&
      segment.trim() !== ""
    ) {
      classes.push(opts.novelClass as string);
    }
    if (ri + 1 < refs.length && (refs[ri] as number) <= a && b <= (refs[ri + 1] as number))
      classes.push("ref");
    if (opts.word && opts.word[0] <= a && b <= opts.word[1]) classes.push("wc");
    html += classes.length
      ? `<span class="${classes.join(" ")}">${escapeHtml(segment)}</span>`
      : escapeHtml(segment);
  }
  return html;
}

/** Whether a row shows a change on either side. */
export function rowChanged(file: FileDiff, row: Row): boolean {
  const [o, n] = row;
  if (o === null || n === null) return true;
  return (file.old?.novel[o]?.length ?? 0) > 0 || (file.new?.novel[n]?.length ?? 0) > 0;
}

export interface RowMarks {
  /** New-side lines (1-based) covered by agent notes. */
  readonly noted: ReadonlySet<number>;
  /** New-side lines (1-based) changed since the previous revision. */
  readonly since: ReadonlySet<number>;
  readonly refs: ReadonlySet<string>;
  /** Rows the agent marked as tests. */
  readonly tests: ReadonlySet<number>;
  /** The user's vim marks, by `side:line` (1-based). */
  readonly named?: ReadonlyMap<string, string>;
}

function cell(
  side: "old" | "new",
  text: SideText | null,
  line: number | null,
  otherMissing: boolean,
  marks: RowMarks,
): string {
  if (text === null || line === null) return '<div class="num empty"></div><div class="code empty"></div>';
  const novel = side === "old" ? text.novel[line] : text.novel[line];
  const changed = otherMissing || (novel?.length ?? 0) > 0;
  const n = line + 1;
  let cls = `num ${side}`;
  if (changed) cls += side === "old" ? " del" : " add";
  if (side === "new" && marks.noted.has(n)) cls += " noted";
  if (side === "new" && marks.since.has(n)) cls += " since";
  const body = lineHtml(text.lines[line] ?? "", text.syntax[line], novel, {
    novelClass: side === "old" ? "nv-del" : "nv-add",
    refs: marks.refs,
  });
  const mark = marks.named?.get(`${side}:${n}`);
  const markHtml = mark ? `<i class="mk">${mark}</i>` : "";
  return `<div class="${cls}" data-n="${n}" data-side="${side}">${markHtml}</div><div class="code" data-side="${side}">${body}</div>`;
}

/** One aligned row of the split view. */
export function rowHtml(fileIndex: number, rowIndex: number, file: FileDiff, marks: RowMarks): string {
  const row = file.rows[rowIndex];
  if (!row) return "";
  const [o, n] = row;
  const chg = rowChanged(file, row) ? 1 : 0;
  return (
    `<div class="row${marks.tests.has(rowIndex) ? " test" : ""}" data-f="${fileIndex}" data-r="${rowIndex}" data-ol="${o === null ? "" : o + 1}" ` +
    `data-nl="${n === null ? "" : n + 1}" data-chg="${chg}">` +
    cell("old", file.old, o, n === null, marks) +
    cell("new", file.new, n, o === null, marks) +
    "</div>"
  );
}

export type ChangeMark = "add" | "mod" | "del" | "";

/**
 * File view marks for each line of one side: added, changed, or a notch where
 * lines were removed just above.
 */
export function changeMarks(file: FileDiff, side: "old" | "new"): ChangeMark[] {
  const text = side === "old" ? file.old : file.new;
  const marks: ChangeMark[] = new Array<ChangeMark>(text?.lines.length ?? 0).fill("");
  let removedAbove = false;
  for (const row of file.rows) {
    const mine = side === "old" ? row[0] : row[1];
    const theirs = side === "old" ? row[1] : row[0];
    if (mine === null) {
      removedAbove = true;
      continue;
    }
    if (side === "new" && theirs === null) marks[mine] = "add";
    else if (side === "new" && rowChanged(file, row)) marks[mine] = "mod";
    else if (removedAbove && side === "new") marks[mine] = "del";
    removedAbove = false;
  }
  return marks;
}

/** One line of the file view: change mark, number, code. */
export function fileViewRowHtml(
  fileIndex: number,
  rowIndex: number,
  side: "old" | "new",
  line: number,
  text: SideText,
  mark: ChangeMark,
  refs: ReadonlySet<string>,
): string {
  const n = line + 1;
  const body = lineHtml(text.lines[line] ?? "", text.syntax[line], undefined, { novelClass: null, refs });
  return (
    `<div class="row" data-f="${fileIndex}" data-r="${rowIndex}" data-${side === "old" ? "ol" : "nl"}="${n}" data-chg="0">` +
    `<div class="mark ${mark}"></div><div class="num" data-n="${n}" data-side="${side}"></div>` +
    `<div class="code" data-side="${side}">${body}</div></div>`
  );
}
