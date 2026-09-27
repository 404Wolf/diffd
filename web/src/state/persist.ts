/**
 * What the page remembers between reloads, per review and per tab (in
 * sessionStorage, so tabs don't trample each other), with the latest copy
 * also in localStorage to start new tabs from:
 * which lines are expanded, where you were reading, the cursor, and a comment
 * you were in the middle of writing. (Sent-but-unconfirmed messages live in
 * the socket's outbox; viewed files and marks in the view state.)
 *
 * Everything is keyed by file path and checked against the file's current
 * shape before use, so a new revision never restores nonsense.
 */
import type { Side } from "../api";
import type { Composer } from "./view";

/** Visible rows of a file, as `[start, end)` runs, for a file with `rows` rows. */
export interface SavedVisibility {
  readonly rows: number;
  readonly runs: [number, number][];
}

export interface SavedPlace {
  readonly path: string;
  readonly row: number;
  /** Pixels from the top of the buffer to the row (reading position only). */
  readonly offset: number;
  readonly side: Side;
}

export interface Session {
  visibility: Record<string, SavedVisibility>;
  collapsed: Record<string, boolean>;
  reading: SavedPlace | null;
  cursor: SavedPlace | null;
  draft: { composer: Composer; text: string } | null;
}

const empty = (): Session => ({ visibility: {}, collapsed: {}, reading: null, cursor: null, draft: null });

export function loadSession(reviewId: string): Session {
  const key = `diffd:session:${reviewId}`;
  for (const storage of [() => sessionStorage, () => localStorage]) {
    try {
      const raw = storage().getItem(key);
      if (raw) return { ...empty(), ...(JSON.parse(raw) as Partial<Session>) };
    } catch {
      // Unavailable or not ours: try the next one.
    }
  }
  return empty();
}

/** Writes are batched: many small changes (scrolling, typing) become one write. */
export function sessionWriter(reviewId: string, session: Session) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const json = JSON.stringify(session);
    for (const storage of [() => sessionStorage, () => localStorage]) {
      try {
        storage().setItem(`diffd:session:${reviewId}`, json);
      } catch {
        // Storage full or unavailable: the page works, it just won't remember.
      }
    }
  };
  addEventListener("pagehide", flush);
  return {
    session,
    update(change: (s: Session) => void) {
      change(session);
      timer ??= setTimeout(flush, 400);
    },
    flush,
  };
}

export type SessionWriter = ReturnType<typeof sessionWriter>;

export function toRuns(visible: Uint8Array): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= visible.length; i++) {
    const on = i < visible.length && visible[i] === 1;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      runs.push([start, i]);
      start = -1;
    }
  }
  return runs;
}

export function fromRuns(saved: SavedVisibility, rows: number): Uint8Array | null {
  if (saved.rows !== rows) return null;
  const out = new Uint8Array(rows);
  for (const [a, b] of saved.runs) out.fill(1, Math.max(0, a), Math.min(rows, b));
  return out;
}
