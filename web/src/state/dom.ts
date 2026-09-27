/** Finding rows in the rendered diff, and changing the DOM without moving the reader. */

import type { ListNav } from "./layout";

let focusedPane = 0;
/** Which split keys and commands act on (see `View.focusPane`). */
export const setFocusedPane = (id: number): void => {
  focusedPane = id;
};

/** A pane's scrolling buffer; the focused pane's by default. */
export const bufferEl = (pane: number = focusedPane): HTMLElement | null =>
  document.getElementById(`buffer-${pane}`);

/** Where the reader is: the row at the top of the screen, and its top's offset from the buffer's top. */
export interface ReadingPosition {
  readonly file: number;
  readonly row: number;
  readonly offset: number;
}

/**
 * A pane's windowed multibuffer: only items near the viewport are in the DOM,
 * so anything that moves to a row goes through here rather than the row's element.
 */
export interface Windowed {
  /** The list it shows, to move through. */
  readonly nav: ListNav;
  /** What a sticky header covers at the top of the screen. */
  readonly topInset: number;
  /** Scroll so item `index` is in view, rendering it right away. */
  /** `top` / `bottom`: the item just below the sticky header / just above the bottom edge (vim's zt, zb). */
  reveal(index: number, how: "nearest" | "center" | "start" | "top" | "bottom"): void;
  reading(): ReadingPosition | null;
  /** Scroll so the row sits at `offset` from the top again, rendering it right away. */
  restore(pos: ReadingPosition): void;
  /**
   * Where a row is on screen (or with `cards`, the thread cards under it),
   * whether or not it's rendered: its top and bottom in client coordinates.
   */
  box(file: number, row: number, cards?: boolean): { readonly top: number; readonly bottom: number } | null;
}

const windows = new Map<number, Windowed>();
/** Register (or with null, drop) a pane's windowed multibuffer. */
export const setWindowed = (pane: number, w: Windowed | null): void => {
  if (w) windows.set(pane, w);
  else windows.delete(pane);
};
/** A pane's windowed multibuffer (the focused pane's by default), while it shows the diff. */
export const windowed = (pane: number = focusedPane): Windowed | null => windows.get(pane) ?? null;
const windowOf = (buf: HTMLElement): Windowed | null => windows.get(Number(buf.dataset.pane)) ?? null;

/** Fired on `document` after rows are (re)rendered, for painters that decorate rows. */
export const rowsRenderedEvent = "diffd:rows-rendered";
let announced = 0;
/** Tell painters once per frame, however many rows were rendered. */
export function announceRows(): void {
  cancelAnimationFrame(announced);
  announced = requestAnimationFrame(() => document.dispatchEvent(new Event(rowsRenderedEvent)));
}

/** Every pane's buffer, left to right. */
export const allBuffers = (): HTMLElement[] =>
  // The panes' container, not the whole document: a big diff has hundreds of thousands of nodes.
  Array.prototype.filter.call(document.getElementById("panes")?.children ?? [], (el: Element) =>
    el.classList.contains("buffer"),
  ) as HTMLElement[];

/** Every rendered row in a buffer, by `file:row`, for painters that decorate rows. */
interface RowIndex {
  readonly byKey: Map<string, HTMLElement>;
}

/**
 * One index per pane's buffer, built when asked for and dropped when the
 * buffer's DOM changes (a MutationObserver), instead of querying on every key press.
 */
const indexes = new WeakMap<HTMLElement, { observer: MutationObserver; index: RowIndex | null }>();

/** Only structural changes matter; repainting a line's code (the symbol cursor) doesn't. */
const structural = (records: MutationRecord[]) =>
  records.some((m) => !(m.target instanceof Element && m.target.closest(".code")));

function rowIndex(buf: HTMLElement | null = bufferEl()): RowIndex | null {
  if (!buf) return null;
  let watching = indexes.get(buf);
  if (!watching) {
    const observer = new MutationObserver((records) => {
      const w = indexes.get(buf);
      if (w && structural(records)) w.index = null;
    });
    observer.observe(buf, { childList: true, subtree: true });
    watching = { observer, index: null };
    indexes.set(buf, watching);
  }
  // Changes made earlier in this same task haven't reached the observer's callback yet.
  if (structural(watching.observer.takeRecords())) watching.index = null;
  if (watching.index) return watching.index;
  const byKey = new Map<string, HTMLElement>();
  for (const r of buf.querySelectorAll<HTMLElement>(".row")) byKey.set(`${r.dataset.f}:${r.dataset.r}`, r);
  watching.index = { byKey };
  return watching.index;
}

/**
 * A row in a pane (the focused one by default), when it's rendered: only rows
 * near the screen are. To move to a row, go through `windowed()`.
 */
export function rowEl(file: number, row: number, buf: HTMLElement | null = bufferEl()): HTMLElement | null {
  return rowIndex(buf)?.byKey.get(`${file}:${row}`) ?? null;
}

export function flash(el: Element): void {
  el.classList.remove("flash");
  void (el as HTMLElement).offsetWidth;
  el.classList.add("flash");
}

/** Where the reader is: the top visible row and its offset. */
export function readingPosition(buf: HTMLElement | null = bufferEl()): ReadingPosition | null {
  return (buf && windowOf(buf)?.reading()) ?? null;
}

/** Scroll so that a row sits at `offset` from the buffer's top edge again. */
export function restoreReadingPosition(pos: ReadingPosition, buf: HTMLElement | null = bufferEl()): void {
  if (buf) windowOf(buf)?.restore(pos);
}
