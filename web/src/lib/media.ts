/**
 * The screen the page is on: phone-narrow, and touch. Signals, so the page
 * follows a fold being opened or a phone turned.
 */
import { type Accessor, createSignal } from "solid-js";

/** Narrower than this, the drawers slide over the code instead of squeezing it (Tailwind's `md`). */
export const NARROW = "(max-width: 767px)";
/** A finger, not a mouse: bigger targets, nothing that only shows on hover. */
export const TOUCH = "(pointer: coarse)";

const cache = new Map<string, Accessor<boolean>>();

/** Whether a media query matches, kept up to date. False where there's no `matchMedia` (tests). */
export function media(query: string): Accessor<boolean> {
  const known = cache.get(query);
  if (known) return known;
  const list = typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query) : null;
  const [matches, setMatches] = createSignal(list?.matches ?? false);
  list?.addEventListener("change", (e) => setMatches(e.matches));
  cache.set(query, matches);
  return matches;
}
