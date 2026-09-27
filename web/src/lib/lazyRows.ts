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
        for (const e of entries) if (e.isIntersecting) fill(e.target as HTMLElement);
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

/** Fill in one placeholder, keeping the page still when it's above the viewport. */
function fill(el: HTMLElement): void {
  const render = renders.get(el);
  pending.delete(el);
  const buf = el.closest<HTMLElement>(".buffer");
  if (buf) observers.get(buf)?.unobserve(el);
  if (!render || !el.isConnected || !el.classList.contains("lazy")) return;
  const before = el.getBoundingClientRect();
  const top = buf?.getBoundingClientRect().top ?? 0;
  el.innerHTML = render();
  el.classList.remove("lazy");
  if (buf && before.bottom <= top) buf.scrollTop += el.getBoundingClientRect().height - before.height;
}

/** Fill in everything that's left (before anything that walks all rows). */
export function fillAll(): void {
  for (const el of [...pending]) fill(el);
}

export const hasPending = (): boolean => pending.size > 0;

function scheduleIdle(): void {
  if (idle) return;
  idle = true;
  const run = (deadline?: IdleDeadline) => {
    const until = performance.now() + (deadline ? Math.min(deadline.timeRemaining(), SLICE_MS) : SLICE_MS);
    for (const el of pending) {
      if (performance.now() > until) break;
      fill(el);
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
