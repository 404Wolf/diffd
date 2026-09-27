import { createEffect, onCleanup, onMount } from "solid-js";
import { textRange } from "../lib/code";
import { occurrences } from "../lib/search";
import { allBuffers, rowEl, rowsRenderedEvent } from "../state/dom";
import type { View } from "../state/view";

/** CSS Custom Highlight names (styles.css). */
const ALL = "search";
const CURRENT = "search-current";

type Registry = Map<string, unknown>;
type HighlightCtor = new (...ranges: Range[]) => { priority: number };

/**
 * Highlight the last search's matches on the rows that are rendered, and the
 * one last gone to more strongly. Painted again whenever rows come into the
 * window, so matches show wherever you scroll.
 */
export function usePaintSearch(props: { view: View }) {
  const registry = (globalThis.CSS as unknown as { highlights?: Registry }).highlights;
  const Highlight = (globalThis as unknown as { Highlight?: HighlightCtor }).Highlight;
  let frame = 0;
  const paint = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!registry || !Highlight) return;
      const s = props.view.search();
      if (!s) {
        registry.delete(ALL);
        registry.delete(CURRENT);
        return;
      }
      const all: Range[] = [];
      const current: Range[] = [];
      const at = s.matches[s.index];
      for (const buf of allBuffers()) {
        for (const code of buf.querySelectorAll<HTMLElement>(".code[data-side]")) {
          for (const [a, b] of occurrences(code.textContent ?? "", s.query)) {
            const range = textRange(code, a, b);
            if (range) all.push(range);
          }
        }
        if (!at) continue;
        const code = rowEl(at.file, at.row, buf)?.querySelector(`.code[data-side="${at.side}"]`);
        const range = code ? textRange(code, at.start, at.end) : null;
        if (range) current.push(range);
      }
      registry.set(ALL, new Highlight(...all));
      const strong = new Highlight(...current);
      strong.priority = 1;
      registry.set(CURRENT, strong);
    });
  };
  createEffect(() => {
    props.view.search();
    for (const p of props.view.panes()) p.mode();
    paint();
  });
  onMount(() => {
    document.addEventListener(rowsRenderedEvent, paint);
    onCleanup(() => {
      document.removeEventListener(rowsRenderedEvent, paint);
      cancelAnimationFrame(frame);
    });
  });
}
