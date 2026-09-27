/**
 * Vim text objects, line-wise (diffd selects whole lines): `ip`/`ap`
 * paragraphs, `i{`/`a{` and friends for bracket pairs, `it`/`at` for
 * markup tags, `if`/`af` and `ic`/`ac` from the definitions tree-sitter found.
 *
 * Lines are 1-based; every function returns `[first, last]` or null.
 */

export type LineRange = readonly [number, number];

export type TextObject = "paragraph" | "function" | "class" | "brace" | "paren" | "bracket" | "tag" | "hunk";

const blank = (s: string | undefined) => s === undefined || s.trim() === "";

/** `ip`: the run of non-blank lines (or blank lines) around `line`; `ap` adds the blank lines after (or before). */
export function paragraph(lines: readonly string[], line: number, around: boolean): LineRange | null {
  if (line < 1 || line > lines.length) return null;
  const kind = blank(lines[line - 1]);
  let a = line;
  let b = line;
  while (a > 1 && blank(lines[a - 2]) === kind) a--;
  while (b < lines.length && blank(lines[b]) === kind) b++;
  if (around && !kind) {
    let c = b;
    while (c < lines.length && blank(lines[c])) c++;
    if (c > b) return [a, c];
    let d = a;
    while (d > 1 && blank(lines[d - 2])) d--;
    return [d, b];
  }
  return [a, b];
}

/**
 * The innermost `open`…`close` pair enclosing column `col` of `line`, as whole
 * lines. `a{` takes the lines with the brackets; `i{` the lines between them
 * (or the same lines when the pair spans fewer than three). Brackets inside
 * quotes are skipped, roughly.
 */
export function pair(
  lines: readonly string[],
  line: number,
  col: number,
  open: string,
  close: string,
  around: boolean,
): LineRange | null {
  const at = (l: number, c: number) => lines[l - 1]?.[c];
  const quoted = quotedColumns(lines);
  const isCode = (l: number, c: number) => !quoted[l - 1]?.has(c);
  // Backwards from the cursor to the unmatched opener.
  let depth = 0;
  let from: [number, number] | null = null;
  outer: for (let l = line; l >= 1; l--) {
    const text = lines[l - 1] ?? "";
    for (let c = l === line ? Math.min(col, text.length - 1) : text.length - 1; c >= 0; c--) {
      if (!isCode(l, c)) continue;
      const ch = at(l, c);
      if (ch === close && !(l === line && c === col)) depth++;
      else if (ch === open) {
        if (depth === 0) {
          from = [l, c];
          break outer;
        }
        depth--;
      }
    }
  }
  if (!from) return null;
  // Forwards from the opener to its match.
  depth = 0;
  for (let l = from[0]; l <= lines.length; l++) {
    const text = lines[l - 1] ?? "";
    for (let c = l === from[0] ? from[1] + 1 : 0; c < text.length; c++) {
      if (!isCode(l, c)) continue;
      const ch = at(l, c);
      if (ch === open) depth++;
      else if (ch === close) {
        if (depth === 0) return inner(from[0], l, around);
        depth--;
      }
    }
  }
  return null;
}

/** `at`/`it`: the innermost markup element (`<div>`…`</div>`) around `line`. Self-closing tags don't count. */
export function tag(lines: readonly string[], line: number, around: boolean): LineRange | null {
  const re = /<(\/?)([A-Za-z][\w.:-]*)\b[^<>]*?(\/?)>/g;
  const stack: { name: string; line: number }[] = [];
  let best: LineRange | null = null;
  lines.forEach((text, i) => {
    for (const m of text.matchAll(re)) {
      const [, closing, name = "", selfClosing] = m;
      if (selfClosing) continue;
      if (!closing) {
        stack.push({ name, line: i + 1 });
        continue;
      }
      // Close the nearest matching open tag (unclosed ones inside are dropped, like browsers do).
      const k = stack.map((s) => s.name).lastIndexOf(name);
      if (k < 0) continue;
      const [openTag] = stack.splice(k);
      if (!openTag) continue;
      const range: LineRange = [openTag.line, i + 1];
      const contains = range[0] <= line && line <= range[1];
      if (contains && (!best || range[1] - range[0] < best[1] - best[0])) best = range;
    }
  });
  return best ? inner(best[0], best[1], around) : null;
}

/** `af`/`if`, `ac`/`ic`: the innermost definition span of those kinds around `line`. */
export function definition(
  spans: readonly { readonly kind: string; readonly lines: readonly [number, number] }[],
  kinds: readonly string[],
  line: number,
  around: boolean,
): LineRange | null {
  let best: LineRange | null = null;
  for (const s of spans) {
    if (!kinds.includes(s.kind) || line < s.lines[0] || line > s.lines[1]) continue;
    if (!best || s.lines[1] - s.lines[0] < best[1] - best[0]) best = [s.lines[0], s.lines[1]];
  }
  return best ? inner(best[0], best[1], around) : null;
}

export const FUNCTION_KINDS = ["function", "method", "macro"] as const;
export const CLASS_KINDS = [
  "class",
  "interface",
  "module",
  "struct",
  "enum",
  "trait",
  "type",
  "implementation",
] as const;

function inner(first: number, last: number, around: boolean): LineRange {
  return around || last - first < 2 ? [first, last] : [first + 1, last - 1];
}

/** Columns inside '…', "…" or `…` on each line (a rough guess that ignores escapes across lines). */
function quotedColumns(lines: readonly string[]): Set<number>[] {
  return lines.map((text) => {
    const inside = new Set<number>();
    let quote: string | null = null;
    for (let c = 0; c < text.length; c++) {
      const ch = text[c] ?? "";
      if (quote) {
        inside.add(c);
        if (ch === "\\") {
          inside.add(++c);
        } else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        // An apostrophe in a word (English) or starting a Rust lifetime (`&'a T`) isn't a string.
        if (ch === "'" && (/\w/.test(text[c - 1] ?? "") || /^'[A-Za-z_]\w*(?!')/.test(text.slice(c))))
          continue;
        quote = ch;
        inside.add(c);
      }
    }
    return inside;
  });
}
