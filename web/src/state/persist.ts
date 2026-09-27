/**
 * What the page remembers between reloads, per review and per tab (in
 * sessionStorage, so tabs don't trample each other), with the latest copy
 * also in localStorage to start new tabs from:
 * which lines are expanded, every split (what it shows, where you were
 * reading in it, its cursor) and which had focus, the commits you were
 * looking at, and a comment you were in the middle of writing.
 * (Sent-but-unconfirmed messages live in the socket's outbox; viewed files and
 * marks in the view state.)
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

/** One split: the diff or a file's view, where you were reading in it, and its cursor. */
export interface SavedPane {
  readonly file: string | null;
  readonly reading: SavedPlace | null;
  readonly cursor: SavedPlace | null;
}

export interface Session {
  visibility: Record<string, SavedVisibility>;
  collapsed: Record<string, boolean>;
  /** The splits, left to right. */
  panes: SavedPane[];
  focused: number;
  /** The commits being looked at, by hash (`to: null`: the working tree); null for the whole review. */
  range: { from: string; to: string | null } | null;
  draft: { composer: Composer; text: string } | null;
}

const empty = (): Session => ({
  visibility: {},
  collapsed: {},
  panes: [],
  focused: 0,
  range: null,
  draft: null,
});

export function loadSession(reviewId: string): Session {
  const key = `diffd:session:${reviewId}`;
  for (const storage of [() => sessionStorage, () => localStorage]) {
    try {
      const raw = storage().getItem(key);
      if (!raw) continue;
      const saved = JSON.parse(raw) as Partial<Session> & {
        reading?: SavedPlace | null;
        cursor?: SavedPlace | null;
      };
      // Before splits were saved, one pane's reading position and cursor were.
      const panes =
        saved.panes ??
        (saved.reading || saved.cursor
          ? [{ file: null, reading: saved.reading ?? null, cursor: saved.cursor ?? null }]
          : []);
      return { ...empty(), ...saved, panes };
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
