/**
 * The Showing board's logic, apart from its components: ordering the tray,
 * what counts as news, the links it uses, and code as HTML rows.
 */
import type { BoardItem } from "../api";
import { lineHtml } from "./render";

/** Whether the agent presented something the user hasn't seen: a new item, or a new revision. */
export const isNew = (item: BoardItem): boolean => item.revision > item.seenRevision;

/**
 * The tray's order: open items, then minimised ones; within each, as the
 * server sends them (most recently presented first). Hidden items are listed
 * separately, under "Hidden".
 */
export function trayOrder(items: readonly BoardItem[]): { shown: BoardItem[]; hidden: BoardItem[] } {
  const open = items.filter((i) => i.state === "open");
  const minimised = items.filter((i) => i.state === "minimised");
  return { shown: [...open, ...minimised], hidden: items.filter((i) => i.state === "hidden") };
}

/** The item after (or before) `id` among `items`, wrapping around; the first when `id` isn't there. */
export function neighbour(items: readonly BoardItem[], id: string | null, step: 1 | -1): BoardItem | undefined {
  if (items.length === 0) return undefined;
  const at = items.findIndex((i) => i.id === id);
  if (at < 0) return step === 1 ? items[0] : items[items.length - 1];
  return items[(at + step + items.length) % items.length];
}

/** An image of an item: its picture (`name` empty) or one its document shows. The revision makes a new version a new URL. */
export function assetUrl(item: Pick<BoardItem, "id" | "revision">, name: string): string {
  const query = new URLSearchParams({ name, rev: String(item.revision) });
  return `/api/board/${encodeURIComponent(item.id)}/asset?${query}`;
}

/** The page's address with `item` open (or none), on the board the page is for (`null`: every board's). */
export function boardPath(scope: string | null, item: string | null): string {
  if (scope === null) return item ? `/show?open=${encodeURIComponent(item)}` : "/show";
  const base = `/show/${encodeURIComponent(scope)}`;
  return item ? `${base}/${encodeURIComponent(item)}` : base;
}

/** The item a page address opens, if any: `/show/<scope>/<id>` or `/show?open=<id>`. */
export function openFromLocation(loc: Pick<Location, "pathname" | "search">): string | null {
  const m = /^\/show\/[^/]+\/([^/]+)\/?$/.exec(loc.pathname);
  if (m?.[1]) return decodeURIComponent(m[1]);
  return new URLSearchParams(loc.search).get("open");
}

/** Who presented an item, in a few words: "t1n7 · worker · server". */
export function presenter(item: BoardItem): string {
  const s = item.source;
  return [s.terminal ?? s.agent, s.role, s.machine].filter((x): x is string => Boolean(x)).join(" · ");
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ESCAPES[c] ?? c);

/** A diff line's kind, from its first character. */
function diffClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return " d-file";
  if (line.startsWith("@@")) return " d-hunk";
  if (line.startsWith("+")) return " d-add";
  if (line.startsWith("-")) return " d-del";
  return "";
}

/**
 * Code or text as HTML rows: a line number, then the line, highlighted with
 * the same classes as the diff. Lines in `lit` (first and last) are marked.
 */
export function codeRowsHtml(
  text: string,
  syntax: readonly (readonly number[])[],
  opts: { readonly language: string | null; readonly lit: readonly [number, number] | null },
): string {
  const diff = opts.language === "Diff";
  const lines = text.split("\n");
  // A file's final newline isn't a line of its own.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines
    .map((line, i) => {
      const n = i + 1;
      const lit = opts.lit && n >= opts.lit[0] && n <= opts.lit[1] ? " lit" : "";
      const kind = diff ? diffClass(line) : "";
      const body = syntax[i] ? lineHtml(line, syntax[i], undefined, { novelClass: null }) : escapeHtml(line);
      return `<div class="cl${lit}${kind}" data-line="${n}"><span class="ln" aria-hidden="true">${n}</span><span class="ct">${body}</span></div>`;
    })
    .join("");
}
