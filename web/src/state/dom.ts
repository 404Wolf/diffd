/** Finding rows in the rendered diff, and changing the DOM without moving the reader. */

export const bufferEl = (): HTMLElement | null => document.getElementById("buffer");

export function rowEl(file: number, row: number): HTMLElement | null {
  return bufferEl()?.querySelector<HTMLElement>(`.row[data-f="${file}"][data-r="${row}"]`) ?? null;
}

/** Rows the cursor can move through: rendered and not inside a folded gap. */
export function navigableRows(): HTMLElement[] {
  const buf = bufferEl();
  if (!buf) return [];
  return [...buf.querySelectorAll<HTMLElement>(".row")].filter((r) => !r.closest(".gap-body[hidden]"));
}

/** The first row whose bottom is below the top of the viewport (under sticky headers). */
export function topVisibleRow(): HTMLElement | null {
  const buf = bufferEl();
  if (!buf) return null;
  const top = buf.getBoundingClientRect().top + 34;
  for (const r of navigableRows()) if (r.getBoundingClientRect().bottom > top) return r;
  return null;
}

/**
 * Run a DOM-changing update and keep the row at the top of the screen exactly
 * where it was. Every structural change in the diff goes through this.
 */
export function keepViewport(update: () => void): void {
  const buf = bufferEl();
  const anchor = topVisibleRow();
  if (!buf || !anchor) {
    update();
    return;
  }
  const { f, r } = anchor.dataset;
  const before = anchor.getBoundingClientRect().top;
  update();
  const after = buf.querySelector<HTMLElement>(`.row[data-f="${f}"][data-r="${r}"]`);
  if (after) buf.scrollTop += after.getBoundingClientRect().top - before;
}

export const follows = (a: Node, b: Node): boolean =>
  Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

/** Scroll a row into view if needed (`nearest`) or into the middle (`center`). */
export function reveal(el: Element, how: "nearest" | "center" = "nearest"): void {
  el.scrollIntoView({ block: how });
}

export function flash(el: Element): void {
  el.classList.remove("flash");
  void (el as HTMLElement).offsetWidth;
  el.classList.add("flash");
}

/** Where the reader is: the top visible row and its offset. */
export function readingPosition(): { file: number; row: number; offset: number } | null {
  const buf = bufferEl();
  const top = topVisibleRow();
  if (!buf || !top) return null;
  return {
    file: Number(top.dataset.f),
    row: Number(top.dataset.r),
    offset: top.getBoundingClientRect().top - buf.getBoundingClientRect().top,
  };
}

/** Scroll so that a row sits at `offset` from the buffer's top edge again. */
export function restoreReadingPosition(pos: { file: number; row: number; offset: number }): void {
  const buf = bufferEl();
  const el = rowEl(pos.file, pos.row);
  if (!buf || !el) return;
  // Twice: the first scroll can render sections whose real height differs from their placeholder.
  for (let i = 0; i < 2; i++) {
    buf.scrollTop += el.getBoundingClientRect().top - buf.getBoundingClientRect().top - pos.offset;
  }
}
