/**
 * A windowed list of items in a pane's scrolling buffer: only the items within
 * a couple of screens of the viewport are in the DOM. What isn't rendered is
 * stood in for by its height: estimated (lines wrap in a known number of
 * columns), then measured once rendered. Heights live in a Fenwick tree
 * (`lib/windower.ts`), so finding the items at a scroll position is O(log n).
 *
 * The reader never sees anything move: items rendered above the viewport that
 * come out taller or shorter than estimated shift the scroll position by the
 * difference, and every layout change (a gap expanding, a file collapsing, a
 * thread arriving, a revision) keeps the item at the top of the screen where
 * it was.
 *
 * The multibuffer (`Multibuffer.tsx`) and file view (`Buffer.tsx`) are both
 * such lists; the pane registers the one it shows (`state/dom.ts`), and
 * commands move through its items (`state/layout.ts`), not its DOM.
 */

import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount } from "solid-js";
import { match } from "ts-pattern";
import { Heights } from "../lib/windower";
import { announceRows, setWindowed, type Windowed } from "../state/dom";
import { type Item, type ListNav, type RowItem, sameItem } from "../state/layout";
import type { Pane } from "../state/view";

/**
 * Rendered beyond the viewport: far ahead in the direction of scrolling, so a
 * fling the compositor scrolls before the page catches up still lands on real
 * rows, and a little behind.
 */
const AHEAD_PX = 2400;
const BEHIND_PX = 600;
/** Re-window once less than this is rendered ahead of the viewport (or behind it). */
const MIN_AHEAD_PX = 1500;
const MIN_BEHIND_PX = 100;
/**
 * After a jump (nothing rendered is near the new place), the first frame
 * renders only this far around the screen, so it shows quickly; the rest of
 * the window follows in the next frame.
 */
const JUMP_MARGIN_PX = 200;
/**
 * A list this short (a few hundred rows) is rendered whole: windowing it
 * would save little, and every row being in the page keeps things simple.
 */
const RENDER_ALL_PX = 12_000;
/** Keep the cursor this far from the edges when scrolling it into view (like `scroll-margin`). */
const MARGIN_TOP_PX = 10;
const MARGIN_BOTTOM_PX = 20;

/** Where the viewport is over the list, after a scroll or a re-window. */
export interface ListView {
  /** The viewport's top, in the list's coordinates. */
  readonly top: number;
  readonly items: readonly Item[];
  indexAt(y: number): number;
  offset(index: number): number;
}

interface Props {
  pane: Pane;
  /** The pane's scrolling element. */
  buf: () => HTMLElement | undefined;
  nav: ListNav;
  /** An item's height before it's measured. */
  estimate: (item: Item) => number;
  /** The buffer's width (or the code font) changed: recompute what estimates depend on. */
  onWidth: (width: number, charWidth: number) => void;
  render: (item: Item) => JSX.Element;
  /** What a sticky header covers at the top of the viewport. */
  topInset: number;
  onView?: (view: ListView) => void;
  /**
   * Rendered items are grouped by this key (each group's items are
   * consecutive), each group wrapped by `wrap`: the multibuffer puts each
   * file's items in a `<section>`.
   */
  groupOf?: (item: Item) => string;
  wrap?: (key: string, children: JSX.Element) => JSX.Element;
}

export function WindowedList(props: Props) {
  let win!: HTMLDivElement;
  let sizer!: HTMLDivElement;
  let probe!: HTMLSpanElement;

  /** The items as last laid out, their heights, and which of them are rendered. */
  let list: readonly Item[] = [];
  let heights = new Heights([]);
  let range = { start: 0, end: 0 };
  const [shown, setShown] = createSignal<readonly Item[]>([]);
  /** Measured heights, kept across layout changes; dropped when the width changes. */
  let measured = new WeakMap<Item, number>();
  /** The element each rendered item is, and the other way round. */
  const elOf = new WeakMap<Item, HTMLElement>();
  const itemOf = new WeakMap<Element, Item>();
  let width = -1;
  let started = false;

  const sizeOf = (item: Item) => measured.get(item) ?? props.estimate(item);
  /** Where the list starts in the buffer's scrolling content (below a file view's header, say). */
  const origin = () => sizer.offsetTop;
  /** The viewport's top in the list's coordinates. */
  const viewTop = (buf: HTMLElement) => buf.scrollTop - origin();
  const scrollTo = (buf: HTMLElement, y: number) => {
    buf.scrollTop = y + origin();
  };

  const measureWidth = (buf: HTMLElement): boolean => {
    if (buf.clientWidth === width) return false;
    width = buf.clientWidth;
    props.onWidth(width, probe.getBoundingClientRect().width / 100 || 7.2);
    measured = new WeakMap();
    return true;
  };

  // -- Keeping the reader's place ------------------------------------------------------

  /**
   * Heights for a new list. A layout change touches one file (a comment, a
   * gap expanding), so the unchanged runs at either end keep their heights and
   * only the items between are sized: cheap even for 100k items.
   */
  const heightsFor = (next: readonly Item[], resized: boolean): Heights => {
    if (resized) return new Heights(next.map(sizeOf));
    const sizes = new Float64Array(next.length);
    let head = 0;
    while (head < next.length && head < list.length && next[head] === list[head]) {
      sizes[head] = heights.size(head);
      head++;
    }
    let tail = 0;
    while (
      tail < next.length - head &&
      tail < list.length - head &&
      next[next.length - 1 - tail] === list[list.length - 1 - tail]
    ) {
      sizes[next.length - 1 - tail] = heights.size(list.length - 1 - tail);
      tail++;
    }
    for (let i = head; i < next.length - tail; i++) sizes[i] = sizeOf(next[i] as Item);
    return new Heights(sizes);
  };

  /**
   * Take a new list of items (or, `resized`, new estimates for the same ones),
   * keeping the top item in place.
   */
  const rebuild = (next: readonly Item[], resized = false) => {
    const buf = props.buf();
    if (!buf) return;
    const top = viewTop(buf);
    const index = heights.indexAt(Math.max(0, top));
    const held = list.length > 0 && top >= 0 ? list[index] : undefined;
    const into = top - heights.offset(index);
    heights = heightsFor(next, resized);
    list = next;
    sizer.style.height = `${heights.total()}px`;
    if (held) {
      const at = props.nav.relocate(held);
      // The item itself keeps its offset; one standing in for it (its file's header) goes to the top.
      const same = list[at] !== undefined && sameItem(list[at] as Item, held);
      if (at >= 0) scrollTo(buf, heights.offset(at) + (same ? into : 0));
    }
    update(true);
  };

  // -- Rendering the window ------------------------------------------------------------

  /**
   * The item a text selection starts in. Dragging a selection far away keeps
   * it rendered (and every item between), or the selection would lose its start.
   */
  let pinned: Item | null = null;
  const pinnedIndex = (): number => {
    if (!pinned) return -1;
    const at = props.nav.relocate(pinned);
    return list[at] !== undefined && sameItem(list[at] as Item, pinned) ? at : -1;
  };
  const onSelectionChange = () => {
    const sel = getSelection();
    const node = sel && !sel.isCollapsed ? sel.anchorNode : null;
    let el: Element | null = node ? (node instanceof Element ? node : node.parentElement) : null;
    while (el && el !== win && !itemOf.has(el)) el = el.parentElement;
    const next = el ? (itemOf.get(el) ?? null) : null;
    if (next === pinned) return;
    pinned = next;
    update();
  };

  /** A jump rendered only the screen; the rest of the window comes next frame. */
  let filling = false;
  /** Which way the reader last scrolled, to render further ahead that way. */
  let down = true;
  let lastTop = 0;
  /** Render the items around the viewport, unless what's rendered already covers it with room to spare. */
  const update = (force = false) => {
    const buf = props.buf();
    if (!buf) return;
    const top = viewTop(buf);
    const bottom = top + buf.clientHeight;
    const total = heights.total();
    if (top !== lastTop) down = top > lastTop;
    lastTop = top;
    // Until a jump's fill arrives next frame, the screen itself is enough.
    const [above, below] = filling
      ? [JUMP_MARGIN_PX, JUMP_MARGIN_PX]
      : down
        ? [MIN_BEHIND_PX, MIN_AHEAD_PX]
        : [MIN_AHEAD_PX, MIN_BEHIND_PX];
    const pin = pinnedIndex();
    const covered =
      range.end > range.start &&
      (pin < 0 || (pin >= range.start && pin < range.end)) &&
      heights.offset(range.start) <= Math.max(0, top - above) &&
      heights.offset(range.end) >= Math.min(total, bottom + below);
    if (force || !covered) {
      // A jump: what's rendered is nowhere near. Show the screen first, fill around it next frame.
      const jumped =
        !force &&
        range.end > range.start &&
        (heights.offset(range.end) < top - JUMP_MARGIN_PX ||
          heights.offset(range.start) > bottom + JUMP_MARGIN_PX);
      if (jumped && !filling) {
        filling = true;
        requestAnimationFrame(() => {
          filling = false;
          if (!disposed) update(true);
        });
      }
      const [before, after] = filling
        ? [JUMP_MARGIN_PX, JUMP_MARGIN_PX]
        : down
          ? [BEHIND_PX, AHEAD_PX]
          : [AHEAD_PX, BEHIND_PX];
      const whole = total <= RENDER_ALL_PX;
      let start = list.length && !whole ? heights.indexAt(Math.max(0, top - before)) : 0;
      let end =
        list.length && !whole
          ? Math.min(list.length, heights.indexAt(Math.max(0, bottom + after)) + 1)
          : list.length;
      // Keep where a text selection starts, and everything up to it, rendered.
      if (pin >= 0) {
        start = Math.min(start, pin);
        end = Math.max(end, pin + 1);
      }
      range = { start, end };
      win.style.transform = `translateY(${heights.offset(start)}px)`;
      setShown(list.slice(start, end));
      measure();
    }
    props.onView?.({
      top,
      items: list,
      indexAt: (y) => heights.indexAt(y),
      offset: (i) => heights.offset(i),
    });
  };

  let measuring = false;
  /** A measurement waiting for the DOM to catch up. */
  let deferred = false;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  /**
   * Measure what's rendered, once it is: rendering from inside an effect
   * happens after it. Try again in a microtask (before the frame is drawn),
   * then once a frame for a few frames: retrying only in microtasks would
   * never yield if the DOM never caught up (a list being taken down).
   */
  const measure = () => {
    if (measureNow() || deferred) return;
    deferred = true;
    let frames = 10;
    const retry = () => {
      if (disposed || measureNow() || --frames <= 0) deferred = false;
      else requestAnimationFrame(retry);
    };
    queueMicrotask(() => {
      if (disposed || measureNow()) deferred = false;
      else requestAnimationFrame(retry);
    });
  };
  /**
   * Measure what's rendered; false when the DOM hasn't caught up yet. Items
   * above the top of the viewport that differ from their estimate move the
   * scroll position by the difference, so the reader sees nothing move.
   */
  const measureNow = (): boolean => {
    const buf = props.buf();
    if (!buf || measuring || disposed) return true;
    const { start, end } = range;
    const kids: HTMLElement[] = [];
    for (let i = start; i < end; i++) {
      const el = elOf.get(list[i] as Item);
      if (!el?.isConnected) break;
      kids.push(el);
    }
    if (kids.length !== end - start) return false;
    measuring = true;
    const top = viewTop(buf);
    const first = heights.indexAt(Math.max(0, top));
    let shift = 0;
    let changed = false;
    for (let k = 0; k < kids.length; k++) {
      const index = start + k;
      const item = list[index] as Item;
      const h = (kids[k] as HTMLElement).getBoundingClientRect().height;
      measured.set(item, h);
      const delta = heights.set(index, h);
      if (delta === 0) continue;
      changed = true;
      if (index < first && top > 0) shift += delta;
    }
    if (changed) sizer.style.height = `${heights.total()}px`;
    if (shift !== 0) scrollTo(buf, top + shift);
    measuring = false;
    announceRows();
    // Shorter than estimated: what's rendered may no longer reach past the viewport.
    if (changed) update();
    return true;
  };

  // -- What the rest of the page asks of this buffer ------------------------------------

  const api: Windowed = {
    nav: props.nav,
    reveal(index, how) {
      const buf = props.buf();
      if (!buf || !ready()) return;
      const inset = props.topInset + MARGIN_TOP_PX;
      // Twice: the first pass renders the item's neighbours, whose measured heights can move it.
      for (let pass = 0; pass < 2; pass++) {
        const y = heights.offset(index);
        const size = heights.size(index);
        const top = viewTop(buf);
        const h = buf.clientHeight;
        const next = match(how)
          .with("start", () => y)
          .with("top", () => y - inset)
          .with("bottom", () => y + size - h + MARGIN_BOTTOM_PX)
          .with("center", () => y - (h - size) / 2)
          .with("nearest", () =>
            y < top + inset
              ? y - inset
              : y + size > top + h - MARGIN_BOTTOM_PX
                ? y + size - h + MARGIN_BOTTOM_PX
                : top,
          )
          .exhaustive();
        if (Math.abs(next - top) < 1) break;
        scrollTo(buf, next);
        update();
      }
    },
    reading() {
      const buf = props.buf();
      if (!buf || !ready()) return null;
      // The first row whose bottom is below the sticky header: the row at that line,
      // or when a header, gap or card is there, the next row.
      const top = Math.max(0, viewTop(buf) + props.topInset);
      const { rows } = props.nav.layout();
      let pos = Math.max(0, props.nav.rowPositionAt(heights.indexAt(top)));
      const below = (i: number) => heights.offset(i) + heights.size(i) > top;
      if (rows[pos] !== undefined && !below(rows[pos] as number) && pos + 1 < rows.length) pos++;
      const at = rows[pos];
      const row = at === undefined ? undefined : (list[at] as RowItem | undefined);
      return row && at !== undefined
        ? { file: row.file, row: row.row, offset: heights.offset(at) - viewTop(buf) }
        : null;
    },
    box(file, row, cards = false) {
      const buf = props.buf();
      let index = props.nav.indexOfRow(file, row);
      if (!buf || index < 0 || !ready()) return null;
      if (cards && list[index + 1]?.kind === "threads") index++;
      const top = buf.getBoundingClientRect().top + heights.offset(index) - viewTop(buf);
      return { top, bottom: top + heights.size(index) };
    },
    restore(pos) {
      const buf = props.buf();
      const index = props.nav.indexOfRow(pos.file, pos.row);
      if (!buf || index < 0 || !ready()) return;
      // Twice: rendering the rows around it can correct their estimated heights.
      for (let pass = 0; pass < 2; pass++) {
        scrollTo(buf, heights.offset(index) - pos.offset);
        update();
      }
    },
  };

  /** Set up on first use: the page can ask for a position before this component's own `onMount` runs. */
  const ready = (): boolean => {
    if (started) return true;
    const buf = props.buf();
    if (!buf?.isConnected || !sizer?.isConnected) return false;
    started = true;
    measureWidth(buf);
    rebuild(props.nav.layout().items);
    return true;
  };

  setWindowed(props.pane.id, api);
  onCleanup(() => setWindowed(props.pane.id, null));
  createEffect(
    on(
      () => props.nav.layout().items,
      (next) => {
        if (ready() && next !== list) rebuild(next);
      },
    ),
  );
  onMount(() => {
    ready();
    const buf = props.buf();
    if (!buf) return;
    const onScroll = () => update();
    buf.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("selectionchange", onSelectionChange);
    let height = buf.clientHeight;
    const resized = new ResizeObserver(() => {
      if (measureWidth(buf)) rebuild(list, true);
      else if (buf.clientHeight !== height) update();
      height = buf.clientHeight;
    });
    resized.observe(buf);
    onCleanup(() => {
      buf.removeEventListener("scroll", onScroll);
      document.removeEventListener("selectionchange", onSelectionChange);
      resized.disconnect();
    });
  });

  const render = (item: Item) => {
    const el = props.render(item) as HTMLElement;
    el.classList.add("vitem");
    itemOf.set(el, item);
    elOf.set(item, el);
    // Items outlive their elements (the layout keeps them): let the element go.
    onCleanup(() => {
      if (elOf.get(item) === el) elOf.delete(item);
    });
    return el;
  };
  /** Rendered items by group, in order; each group's items are consecutive. */
  const groups = createMemo(() => {
    const byKey = new Map<string, Item[]>();
    for (const item of shown()) {
      const key = props.groupOf?.(item) ?? "";
      const group = byKey.get(key);
      if (group) group.push(item);
      else byKey.set(key, [item]);
    }
    return byKey;
  });
  const keys = createMemo(() => [...groups().keys()], undefined, {
    equals: (a, b) => a.length === b.length && a.every((k, i) => k === b[i]),
  });

  return (
    <div ref={sizer} class="relative">
      <div ref={win} class="vwin absolute inset-x-0 top-0">
        <For each={keys()}>
          {(key) => {
            const items = <For each={groups().get(key) ?? []}>{render}</For>;
            return props.wrap ? props.wrap(key, items) : items;
          }}
        </For>
      </div>
      {/* Measures the code font's character width, for estimating how lines wrap. */}
      <span ref={probe} class="vwin invisible absolute whitespace-pre" aria-hidden="true">
        {"x".repeat(100)}
      </span>
    </div>
  );
}
