/** Finding rows in the rendered diff, and changing the DOM without moving the reader. */

export const bufferEl = (): HTMLElement | null => document.getElementById("buffer");

/**
 * Every row in the buffer, indexed. Big diffs have 100k+ rows, so the index is
 * built once and kept until the DOM changes (a MutationObserver marks it
 * stale), instead of querying on every key press.
 */
interface RowIndex {
  /** Rows the cursor can move through: rendered and not inside a folded gap. */
  readonly rows: HTMLElement[];
  readonly position: Map<HTMLElement, number>;
  /** Every row, folded ones too, by `file:row`. */
  readonly byKey: Map<string, HTMLElement>;
  /** Rows that start a run of changes. */
  readonly hunks: HTMLElement[];
}

let index: RowIndex | null = null;
let watching: { buf: HTMLElement; observer: MutationObserver } | null = null;

/** Only structural changes matter; repainting a line's code (the symbol cursor) doesn't. */
const structural = (records: MutationRecord[]) =>
  records.some((m) => !(m.target instanceof Element && m.target.closest(".code")));

function rowIndex(): RowIndex | null {
  const buf = bufferEl();
  if (!buf) return null;
  if (watching?.buf !== buf) {
    watching?.observer.disconnect();
    const observer = new MutationObserver((records) => {
      if (structural(records)) index = null;
    });
    observer.observe(buf, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    watching = { buf, observer };
    index = null;
  }
  // Changes made earlier in this same task haven't reached the observer's callback yet.
  if (structural(watching.observer.takeRecords())) index = null;
  if (index) return index;

  const rows: HTMLElement[] = [];
  const position = new Map<HTMLElement, number>();
  const byKey = new Map<string, HTMLElement>();
  const hunks: HTMLElement[] = [];
  let prev: HTMLElement | undefined;
  for (const r of buf.querySelectorAll<HTMLElement>(".row")) {
    byKey.set(`${r.dataset.f}:${r.dataset.r}`, r);
    if (r.closest(".gap-body[hidden]")) continue;
    position.set(r, rows.length);
    rows.push(r);
    if (r.dataset.chg === "1" && (prev?.dataset.chg !== "1" || prev.dataset.f !== r.dataset.f)) hunks.push(r);
    prev = r;
  }
  index = { rows, position, byKey, hunks };
  return index;
}

export function rowEl(file: number, row: number): HTMLElement | null {
  return rowIndex()?.byKey.get(`${file}:${row}`) ?? null;
}

/** Rows the cursor can move through: rendered and not inside a folded gap. */
export function navigableRows(): readonly HTMLElement[] {
  return rowIndex()?.rows ?? [];
}

/** Where a row is in `navigableRows()`, or -1. */
export function rowPosition(el: HTMLElement): number {
  return rowIndex()?.position.get(el) ?? -1;
}

/** The first row of each run of changed rows. */
export function hunkStarts(): readonly HTMLElement[] {
  return rowIndex()?.hunks ?? [];
}

/** The first row whose bottom is below the top of the viewport (under sticky headers). */
export function topVisibleRow(): HTMLElement | null {
  const buf = bufferEl();
  if (!buf) return null;
  const top = buf.getBoundingClientRect().top + 34;
  const rows = navigableRows();
  // Rows are in document order, so their positions only grow: binary search
  // touches ~17 rows even in huge diffs (and lays out only their chunks).
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = rows[mid];
    if (r && r.getBoundingClientRect().bottom > top) hi = mid;
    else lo = mid + 1;
  }
  return rows[lo] ?? null;
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
