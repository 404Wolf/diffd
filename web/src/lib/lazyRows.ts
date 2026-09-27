/**
 * Long runs of rows are rendered in two steps so a 100k-line diff opens fast.
 *
 * First each chunk is a placeholder holding the chunk's code as plain text,
 * one line per row: cheap to build, and still found by the browser's Ctrl+F.
 * Then chunks are filled in with real rows: near the viewport as you scroll,
 * and the rest in the background while the browser is idle. Anything that
 * needs every row (moving the cursor across the diff, searching) calls
 * `fillAll` first.
 */

type Render = () => string;

const renders = new WeakMap<HTMLElement, Render>();
/** Placeholders not filled in yet, in no particular order. */
const pending = new Set<HTMLElement>();
/** One observer per split's buffer, which is its scroll root. */
const observers = new WeakMap<HTMLElement, IntersectionObserver>();
let idle = false;

/** How far outside the viewport chunks are filled in ahead of scrolling. */
const AHEAD = "1500px 0px";
/** Fired on `document` after placeholders are filled in, for painters that decorate rows. */
export const lazyFilledEvent = "diffd:rows-filled";
/** Background work per idle slice. */
const SLICE_MS = 12;

/** A placeholder for rows `[start, end)`, showing `text` (escaped, one line per row) until it's filled in. */
export function placeholderHtml(start: number, end: number, text: string): string {
  return `<div class="chunk lazy" data-a="${start}" data-b="${end}" style="--n:${end - start}">${text}</div>`;
}

/** Register the placeholders inside `root`; `render(el)` gives each one's real rows. */
export function lazyChunks(root: HTMLElement, render: (el: HTMLElement) => Render): void {
  const buf = root.closest<HTMLElement>(".buffer");
  let observer = buf ? observers.get(buf) : undefined;
  if (!observer) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const el = e.target as HTMLElement;
          if (e.isIntersecting) fill(el, above.has(el));
          else if (e.boundingClientRect.bottom < (e.rootBounds?.top ?? 0)) above.add(el);
          else above.delete(el);
        }
      },
      { root: buf, rootMargin: AHEAD },
    );
    if (buf) observers.set(buf, observer);
  }
  for (const el of root.querySelectorAll<HTMLElement>(".chunk.lazy")) {
    renders.set(el, render(el));
    pending.add(el);
    observer.observe(el);
  }
  scheduleIdle();
}

/**
 * Placeholders the observer last saw above the viewport. Filling one of these
 * changes the height of what's above the reader, so it's measured and the
 * scroll corrected; anything else is filled without touching layout.
 */
const above = new WeakSet<HTMLElement>();

/** Fill in one placeholder; `measure` keeps the page still when it's above the viewport. */
function fill(el: HTMLElement, measure: boolean): void {
  const render = renders.get(el);
  pending.delete(el);
  above.delete(el);
  const buf = el.closest<HTMLElement>(".buffer");
  if (buf) observers.get(buf)?.unobserve(el);
  if (!render || !el.isConnected || !el.classList.contains("lazy")) return;
  const before = measure ? el.getBoundingClientRect().height : 0;
  el.innerHTML = render();
  el.classList.remove("lazy");
  announceFill();
  if (measure && buf) buf.scrollTop += el.getBoundingClientRect().height - before;
}

let announced = 0;
/** Tell painters once per frame, however many chunks were filled. */
function announceFill(): void {
  cancelAnimationFrame(announced);
  announced = requestAnimationFrame(() => document.dispatchEvent(new Event(lazyFilledEvent)));
}

/**
 * Fill in everything that's left (before anything that walks all rows),
 * without measuring each chunk: wrap it in `keepViewport` to hold the reader's place.
 */
export function fillAll(): void {
  for (const el of [...pending]) fill(el, false);
}

export const hasPending = (): boolean => pending.size > 0;

function scheduleIdle(): void {
  if (idle) return;
  idle = true;
  const run = (deadline?: IdleDeadline) => {
    const until = performance.now() + (deadline ? Math.min(deadline.timeRemaining(), SLICE_MS) : SLICE_MS);
    for (const el of pending) {
      if (performance.now() > until) break;
      fill(el, above.has(el));
    }
    for (const el of pending) if (!el.isConnected) pending.delete(el);
    if (pending.size > 0) next();
    else idle = false;
  };
  const next = () =>
    "requestIdleCallback" in window
      ? requestIdleCallback(run, { timeout: 500 })
      : setTimeout(() => run(), 16);
  next();
}
