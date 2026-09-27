/**
 * Everything the user can do, written once and bound to keys, clicks and
 * server events alike.
 */

import { batch } from "solid-js";
import { produce } from "solid-js/store";
import { match } from "ts-pattern";
import type { ActivityItem } from "../gen/ActivityItem";
import type { CodeLocation } from "../gen/CodeLocation";
import type { ShowRequest } from "../gen/ShowRequest";
import type { Side } from "../gen/Side";
import type { Symbol as Definition } from "../gen/Symbol";
import type { Thread } from "../gen/Thread";
import { diagnosticsOn, IDENT, textRange, type WordAt } from "../lib/code";
import {
  type ExpandDirection,
  expandGap,
  growAround,
  initialVisible,
  nearestGap,
  rowOf,
  shrinkAround,
} from "../lib/diffModel";
import { step, steps } from "../lib/history";
import { rowChanged } from "../lib/render";
import { findMatches, MAX_MATCHES, type Match, nextMatch, type Place as SearchPlace } from "../lib/search";
import {
  CLASS_KINDS,
  definition,
  FUNCTION_KINDS,
  type LineRange,
  pair,
  paragraph,
  type TextObject,
  tag,
} from "../lib/textObjects";
import { buildTree, treeOrder } from "../lib/tree";
import {
  bufferEl,
  flash,
  keepViewport,
  readingPosition,
  restoreReadingPosition,
  reveal,
  rowEl,
  windowed,
} from "./dom";
import type { ListNav, RowItem } from "./layout";
import type { Review } from "./review";
import {
  CONTEXT,
  type Cursor,
  EXPAND_STEP,
  type PickerItem,
  type Place,
  type Search,
  type View,
  type Word,
} from "./view";

/** How long `gd` waits for a language server before using the diff's own symbols. */
const LSP_PATIENCE_MS = 1500;
const wait = (ms: number) => new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));

export function createCommands(review: Review, view: View) {
  const files = () => review.snapshot().files;
  const fileName = (i: number) => files()[i]?.path.split("/").pop() ?? "";
  const where = (file: number, line: number, side: Side) =>
    `${fileName(file)}:${line}${side === "old" ? " (old)" : ""}`;

  // -- Places and the jump list ----------------------------------------------

  const here = (): Place => ({
    mode: view.mode(),
    cursor: view.cursor(),
    top: readingPosition(),
  });
  const remember = () => {
    view.jumps.push(here());
    view.syncJumps();
  };
  const restore = (p: Place) => {
    view.setMode(p.mode);
    if (p.top) restoreReadingPosition(p.top);
    view.setCursor(p.cursor);
    view.syncJumps();
  };
  const jumpBack = () => {
    const p = view.jumps.back(here());
    p ? restore(p) : view.say("Start of the jump list");
  };
  const jumpForward = () => {
    const p = view.jumps.forward();
    p ? restore(p) : view.say("End of the jump list");
  };

  // -- Cursor ------------------------------------------------------------------

  const cursorEl = (): HTMLElement | null => {
    const c = view.cursor();
    return c ? rowEl(c.file, c.row) : null;
  };

  /** Whether a row has a line on this side, as shown: file view shows one side only. */
  const hasSide = (file: number, row: number, side: Side): boolean => {
    const f = files()[file];
    const m = view.mode();
    if (m.kind === "file") return side === (f?.new ? "new" : "old");
    const r = f?.rows[row];
    return r !== undefined && r[side === "old" ? 0 : 1] !== null;
  };

  /**
   * What the focused pane shows (the multibuffer or a file view), as a list of
   * items to move through: only rows near the screen are rendered.
   */
  const nav = (): ListNav | null => windowed()?.nav ?? null;
  /** Scroll a row into view, rendering it. */
  const revealRow = (file: number, row: number, how: "nearest" | "center") => {
    const win = windowed();
    const at = win ? win.nav.indexOfRow(file, row) : -1;
    if (win && at >= 0) win.reveal(at, how);
  };

  type PlaceOptions = { side?: Side; word?: Word | null; scroll?: "nearest" | "center" | false };
  /** Put the cursor on a row, keeping the side when that side exists there. */
  const placeRow = (file: number, row: number, opts: PlaceOptions = {}) => {
    const has = (s: Side) => hasSide(file, row, s);
    const current = view.cursor()?.side ?? "new";
    const side =
      opts.side && has(opts.side) ? opts.side : has(current) ? current : current === "new" ? "old" : "new";
    view.setCursor({ file, row, side, word: opts.word ?? null });
    if (opts.scroll !== false) revealRow(file, row, opts.scroll ?? "nearest");
  };
  /** Put the cursor on a rendered row (a click). */
  const place = (el: HTMLElement, opts: PlaceOptions = {}) =>
    placeRow(Number(el.dataset.f), Number(el.dataset.r), opts);
  const placeItem = (item: RowItem | null | undefined, opts: PlaceOptions = {}) => {
    if (item) placeRow(item.file, item.row, opts);
  };
  /** Where the cursor's row is in the pane's items, or -1. */
  const cursorIndex = (): number => {
    const c = view.cursor();
    return c ? (nav()?.indexOfRow(c.file, c.row) ?? -1) : -1;
  };

  const move = (delta: number) => {
    const n = nav();
    if (n) placeItem(n.stepRow(cursorIndex(), delta));
  };
  const edge = (last: boolean) => {
    const n = nav();
    if (!n) return;
    const { rows, items } = n.layout();
    const at = last ? rows.at(-1) : rows[0];
    if (at === undefined) return;
    remember();
    placeItem(items[at] as RowItem, { scroll: "center" });
  };
  /** The first changed row the pane shows (or of one file), else its first row. */
  const firstChange = (file?: number): RowItem | null => {
    const n = nav();
    if (!n) return null;
    const { items, fileStart } = n.layout();
    const from = file === undefined ? 0 : (fileStart[file] ?? 0);
    const to = file === undefined ? items.length : (fileStart[file + 1] ?? items.length);
    let first: RowItem | null = null;
    for (let i = from; i < to; i++) {
      const it = items[i];
      if (it?.kind !== "row") continue;
      first ??= it;
      if (review.models()[it.file]?.changed[it.row] === 1) return it;
    }
    return first;
  };
  /** Start at the first change: on load, and when another part of the history comes up. */
  const startAtFirstChange = (scroll: "center" | false) => placeItem(firstChange(), { scroll });
  const halfPage = () => Math.max(5, Math.floor((bufferEl()?.clientHeight ?? 600) / 36));

  const lineText = (c: Cursor): string => {
    const f = files()[c.file];
    const row = f?.rows[c.row];
    if (!f || !row) return "";
    const line = c.side === "old" ? row[0] : row[1];
    const side = c.side === "old" ? f.old : f.new;
    return line === null ? "" : (side?.lines[line] ?? "");
  };

  const switchSide = () => {
    const c = view.cursor();
    if (!c || view.mode().kind !== "diff") return;
    const other: Side = c.side === "new" ? "old" : "new";
    if (hasSide(c.file, c.row, other)) view.setCursor({ ...c, side: other, word: null });
    else view.say(`This line has no ${other} side`);
  };

  /** `w` / `b`: step the symbol cursor through identifiers, across lines. */
  const stepWord = (dir: 1 | -1) => {
    let c = view.cursor();
    if (!c) return move(0);
    for (let guard = 0; guard < 200; guard++) {
      const words = [...lineText(c).matchAll(IDENT)].map((m) => ({
        text: m[0],
        range: [m.index, m.index + m[0].length] as const,
      }));
      const at = c.word
        ? words.findIndex((w) => w.range[0] === c?.word?.range[0])
        : dir > 0
          ? -1
          : words.length;
      const next = words[at + dir];
      if (next) {
        view.setCursor({ ...c, word: next });
        return;
      }
      const before = c;
      move(dir);
      c = view.cursor();
      if (!c || (c.file === before.file && c.row === before.row)) return;
      c = { ...c, word: null };
    }
  };

  // -- Moving around the diff -----------------------------------------------

  const hunk = (dir: 1 | -1) => {
    const n = nav();
    if (!n) return;
    const { hunks, items } = n.layout();
    const at = cursorIndex();
    const target =
      dir > 0 ? hunks.find((h) => h > at) : at < 0 ? undefined : [...hunks].reverse().find((h) => h < at);
    if (target === undefined) return view.say(dir > 0 ? "No more hunks below" : "No more hunks above");
    remember();
    placeItem(items[target] as RowItem, { scroll: "center" });
  };

  const unhide = (file: number) => {
    const path = files()[file]?.path;
    if (!path || !view.hidden(file)) return;
    keepViewport(() =>
      batch(() => {
        view.setFlags("collapsed", path, false);
        view.setFlags("viewed", path, false);
      }),
    );
  };

  /** Make a row renderable: unfold its file, reveal it with a little context. */
  const ensureRow = (file: number, row: number) => {
    unhide(file);
    const vis = view.visible(file);
    if (vis[row] !== 1) {
      const next = vis.slice();
      next.fill(1, Math.max(0, row - 2), Math.min(vis.length, row + 3));
      keepViewport(() => view.setVisible(file, next));
    }
  };

  /**
   * Put the cursor on a line and show it. With `card`, show that thread too,
   * and with `message`, that message in it. Whether the line was found.
   */
  const goTo = (
    file: number,
    side: Side,
    line: number,
    opts: { word?: Word | null; card?: string; message?: string | undefined } = {},
  ): boolean => {
    const model = review.models()[file];
    if (!model) return false;
    const row = rowOf(model, side, line);
    if (row < 0) {
      view.say(`Line ${line} isn't in ${fileName(file)}`);
      return false;
    }
    remember();
    const m = view.mode();
    // Files outside the diff only have a file view; threads only show in the diff.
    if (review.isContext(file)) view.setMode({ kind: "file", file });
    else if (m.kind === "file" && (m.file !== file || opts.card)) view.setMode({ kind: "diff" });
    if (view.mode().kind === "diff") ensureRow(file, row);
    placeRow(file, row, { side, word: opts.word ?? null, scroll: "center" });
    const el = rowEl(file, row);
    if (el) flash(el);
    if (opts.card) {
      const card = bufferEl()?.querySelector<HTMLElement>(`[data-thread="${opts.card}"]`);
      if (card) {
        // A long thread: the message asked for, else the card's start.
        const target =
          (opts.message && card.querySelector<HTMLElement>(`[data-message="${opts.message}"]`)) || card;
        reveal(target, target === card ? "nearest" : "center");
        card.classList.add("ring-2", "ring-accent");
        setTimeout(() => card.classList.remove("ring-2", "ring-accent"), 1600);
        if (target !== card) flash(target);
      }
    }
    return true;
  };
  // -- Marks -----------------------------------------------------------------------

  const setMark = (name: string) => {
    const c = view.cursor();
    const f = c ? files()[c.file] : undefined;
    const row = c && f ? f.rows[c.row] : undefined;
    const line = row && c ? (c.side === "old" ? row[0] : row[1]) : null;
    if (!c || !f || line === null || line === undefined) return view.say("No line here to mark");
    view.setMarks(name, { path: f.path, side: c.side, line: line + 1, text: lineText(c).trim() });
    view.say(`Mark ${name} set`);
  };
  const jumpToMark = async (name: string) => {
    const m = view.marks[name];
    if (!m) return view.say(`No mark ${name}`);
    // A mark on a file outside the diff opens it again.
    const file = await review.openContext(m.path);
    if (file === null) return view.say(`Mark ${name} is in ${m.path}, which can't be opened`);
    goTo(file, m.side, m.line);
  };
  const deleteMark = (name: string) =>
    view.setMarks(
      produce((marks) => {
        delete marks[name];
      }),
    );

  /** Show a thread, and in it `message` (default: its latest message). */
  const goToThread = async (t: Thread, message = t.messages.at(-1)?.id) => {
    const show = async () => {
      const file = await review.openContext(t.anchor.path);
      return file !== null && goTo(file, t.anchor.side, t.anchor.end, { card: t.id, message });
    };
    if (await show()) return;
    // Viewing one commit, where the thread's lines may not be: go back to the whole review.
    if (review.span() !== null) {
      await review.showSpan(null);
      await new Promise(requestAnimationFrame);
      await show();
    }
  };

  /** The order `]f` walks: the tree's, or the buffer's when reading by group. */
  const order = () =>
    review.grouped() ? review.paths().map((_, i) => i) : treeOrder(buildTree(review.paths()));
  /**
   * The last file `]f` scrolled to that has no rows to put the cursor on (a
   * binary file), with the file the cursor stayed in, so the next `]f` goes on
   * from there instead of back to the same file.
   */
  let rowless: { readonly file: number; readonly cursorFile: number | undefined } | null = null;
  const openFile = (file: number, rememberIt = true) => {
    rowless = null;
    if (rememberIt) remember();
    const m = view.mode();
    if (m.kind === "file" || review.isContext(file)) {
      view.setMode({ kind: "file", file });
      bufferEl()?.scrollTo({ top: 0 });
      const n = nav();
      const first = n?.layout().rows[0];
      if (n && first !== undefined) placeItem(n.layout().items[first] as RowItem, { scroll: false });
      return;
    }
    unhide(file);
    const win = windowed();
    if (!win) return;
    win.reveal(win.nav.layout().fileStart[file] ?? 0, "start");
    const first = firstChange(file);
    if (first) return placeItem(first, { scroll: false });
    rowless = { file, cursorFile: view.cursor()?.file };
    view.say(`${review.paths()[file] ?? "This file"} has nothing to show`);
  };
  /** `]f` / `[f`, in tree order, skipping collapsed and viewed files. */
  const fileJump = (dir: 1 | -1) => {
    const list = order();
    const mode = view.mode();
    const cursorFile = view.cursor()?.file;
    const current =
      mode.kind === "file"
        ? mode.file
        : rowless && rowless.cursorFile === cursorFile
          ? rowless.file
          : (cursorFile ?? list[0] ?? 0);
    let at = list.indexOf(current);
    for (;;) {
      at += dir;
      const next = list[at];
      if (next === undefined)
        return view.say(dir > 0 ? "No more open files below" : "No more open files above");
      if (!view.hidden(next)) return openFile(next);
    }
  };

  /**
   * `]g` / `[g`: the next or previous chapter of the agent's tour, at its
   * first change. Reading by group starts if it hadn't.
   */
  const chapterJump = (dir: 1 | -1) => {
    const chapters = review.groups();
    if (chapters.length === 0) return view.say("The agent hasn't made a tour of this review");
    const c = view.cursor();
    const current = c ? review.groupOf(files()[c.file]?.path ?? "") : -1;
    chapterGo(current < 0 ? (dir > 0 ? 0 : chapters.length - 1) : current + dir);
  };
  /** Go to chapter `i` (0-based) of the tour. */
  const chapterGo = (i: number) => {
    const chapters = review.groups();
    const chapter = chapters[i];
    if (!chapter)
      return view.say(i < 0 ? "That's the first chapter" : "That was the last chapter of the tour");
    if (view.treeMode() !== "groups") view.setTreeMode("groups");
    // Its first file that's shown (labels can hide some).
    const file = chapter.paths.map((p) => review.paths().indexOf(p)).find((f) => f >= 0);
    if (file === undefined) return view.say(`“${chapter.title}” is hidden by labels`);
    openFile(file);
    view.say(`Chapter ${i + 1} of ${chapters.length}: ${chapter.title}`);
  };

  const noteJump = (dir: 1 | -1) => {
    const notes = review.notes();
    const idx = view.noteIndex() < 0 && dir > 0 ? 0 : view.noteIndex() + dir;
    const note = notes[idx];
    if (!note) return view.say(dir > 0 ? "That was the last note" : "That was the first note");
    view.setNoteIndex(idx);
    goToThread(note);
  };

  /** Threads in the pane's order, with the index of the item holding their cards. */
  const threadsInOrder = (): { index: number; thread: Thread }[] => {
    const n = nav();
    if (!n) return [];
    return n
      .layout()
      .items.flatMap((it, index) =>
        it.kind === "threads" ? n.threadsAt(it.file, it.row).map((thread) => ({ index, thread })) : [],
      );
  };
  const threadJump = (dir: 1 | -1) => {
    const at = cursorIndex();
    const all = threadsInOrder();
    // A thread's cards follow the row it ends on (`index - 1`), where going to it puts the cursor.
    const next =
      dir > 0
        ? all.find((t) => at < 0 || t.index - 1 > at)
        : [...all].reverse().find((t) => at >= 0 && t.index - 1 < at);
    if (!next) return view.say("No more threads that way");
    void goToThread(next.thread);
  };

  const activityGo = (item: ActivityItem) => {
    review.markRead(item.seq);
    match(item.kind)
      .with({ type: "userCommented" }, { type: "agentNoted" }, ({ threadId }) => {
        const t = review.threads().find((x) => x.id === threadId);
        if (t) void goToThread(t);
      })
      // The reply itself: the agent's latest message in the thread.
      .with({ type: "agentReplied" }, ({ threadId }) => {
        const t = review.threads().find((x) => x.id === threadId);
        if (t) void goToThread(t, t.messages.findLast((m) => m.author === "agent")?.id);
      })
      .with({ type: "revision" }, ({ paths }) => {
        const file = review.paths().indexOf(paths[0] ?? "");
        if (file >= 0) openFile(file);
      })
      .with({ type: "show" }, ({ request }) => showRequest(request))
      .with({ type: "agentSaid" }, () => focusChat())
      .with({ type: "opened" }, () => noteJump(1))
      .exhaustive();
  };
  const unreadNext = () => {
    const item = review.unread()[0];
    item ? activityGo(item) : view.say("Nothing unread");
  };

  // -- Folding and views ------------------------------------------------------

  const expand = (file: number, start: number, end: number, dir: ExpandDirection) =>
    keepViewport(() => view.setVisible(file, expandGap(view.visible(file), start, end, dir, EXPAND_STEP)));

  /** `g e`: grow the collapsed region nearest the cursor, toward it. */
  const expandNearest = () => {
    const c = view.cursor();
    if (!c || view.mode().kind !== "diff") return;
    const gap = nearestGap(view.visible(c.file), c.row);
    if (!gap) return view.say("No hidden lines in this file");
    expand(c.file, gap.start, gap.end, gap.dir);
  };

  /** `ctrl-enter`: more context above and below the hunk the cursor is in. */
  const expandAround = () => {
    const c = view.cursor();
    if (!c || view.mode().kind !== "diff") return;
    const vis = view.visible(c.file);
    const next = growAround(vis, c.row, EXPAND_STEP);
    if (next.every((v, i) => v === vis[i])) return view.say("Nothing more to show around here");
    keepViewport(() => view.setVisible(c.file, next));
  };

  /** `ctrl-shift-enter`: less context above and below, back toward the changes. */
  const contractAround = () => {
    const c = view.cursor();
    const model = c ? review.models()[c.file] : undefined;
    if (!c || !model || view.mode().kind !== "diff") return;
    const vis = view.visible(c.file);
    const keep = initialVisible(model, CONTEXT, view.pinnedRows(c.file));
    const next = shrinkAround(vis, c.row, EXPAND_STEP, keep);
    if (next.every((v, i) => v === vis[i]))
      return view.say("Only the changes and their context are left here");
    keepViewport(() => view.setVisible(c.file, next));
  };

  // Collapsing or expanding a file moves no one: each split's window keeps the
  // item at its top in place, and a collapsed file's header takes its rows' place.
  const toggleFold = (file: number) => {
    const path = files()[file]?.path;
    if (!path) return;
    const open = view.hidden(file);
    batch(() => {
      view.setFlags("collapsed", path, !open);
      if (open) view.setFlags("viewed", path, false);
    });
  };

  const setViewed = (file: number, viewed: boolean) => {
    const path = files()[file]?.path;
    if (path) view.setFlags("viewed", path, viewed);
  };

  const expandAll = () =>
    keepViewport(() =>
      batch(() => {
        files().forEach((f, i) => {
          view.setVisible(i, new Uint8Array(f.rows.length).fill(1));
          view.setFlags("collapsed", f.path, false);
        });
      }),
    );
  const collapseAll = () =>
    keepViewport(() =>
      batch(() => {
        for (const [i, m] of review.models().entries()) view.setVisible(i, initialVisible(m, CONTEXT));
      }),
    );

  /** `g enter`: the plain file at the cursor. `ctrl-o` comes back. */
  const fileView = () => {
    const c = view.cursor();
    if (!c) return view.say("Put the cursor on a line first");
    if (view.mode().kind === "file") return view.say("Already in file view · ctrl-o to go back");
    remember();
    view.setMode({ kind: "file", file: c.file });
    placeInFileView(c, "center");
  };
  /** In the file view just opened: the cursor's row, or the first row when that side has no line there. */
  const placeInFileView = (c: Cursor, scroll: "center" | false) => {
    const n = nav();
    if (!n) return;
    if (n.indexOfRow(c.file, c.row) >= 0) return placeRow(c.file, c.row, { side: c.side, scroll });
    const first = n.layout().rows[0];
    if (first !== undefined) placeItem(n.layout().items[first] as RowItem, { scroll });
  };

  // -- Splits ------------------------------------------------------------------

  /** `ctrl-\`: split the focused pane; the new one opens at the same place and takes focus. */
  const splitPane = () => {
    const from = bufferEl();
    const reading = readingPosition(from);
    view.split();
    const buf = bufferEl();
    if (reading) restoreReadingPosition(reading, buf);
    buf?.focus({ preventScroll: true });
    view.say(`${view.panes().length} splits · ctrl-h / ctrl-l to move · ctrl-esc to close`);
  };
  /** `ctrl-esc`: close the focused split. */
  const closePane = () => {
    if (!view.closePane()) return view.say("This is the only split");
    bufferEl()?.focus({ preventScroll: true });
  };
  /** `ctrl-h` / `ctrl-l`: focus the split to the left or right. */
  const focusSplit = (dir: 1 | -1) => {
    const ps = view.panes();
    const next = ps[ps.indexOf(view.focused()) + dir];
    if (!next) return;
    view.focusPane(next.id);
    bufferEl()?.focus({ preventScroll: true });
  };
  /** `g space`: the plain file at this line, in the split beside this one (made if needed). */
  const fileInSplit = () => {
    const c = view.cursor();
    if (!c) return view.say("Put the cursor on a line first");
    const ps = view.panes();
    const at = ps.indexOf(view.focused());
    const other = ps[at + 1] ?? ps[at - 1];
    if (other) view.focusPane(other.id);
    else view.split();
    remember();
    view.setMode({ kind: "file", file: c.file });
    placeInFileView(c, "center");
    bufferEl()?.focus({ preventScroll: true });
  };

  // -- Symbols -----------------------------------------------------------------

  const wordAtCursor = (): string | null => {
    const c = view.cursor();
    if (!c) return null;
    if (c.word) return c.word.text;
    const defs = review.definedNames();
    const words = lineText(c).match(IDENT) ?? [];
    return words.find((w) => defs.has(w)) ?? null;
  };
  const rankDefs = (defs: Definition[]) => {
    const file = view.cursor()?.file ?? -1;
    return [...defs].sort((a, b) => Number(b.file === file) - Number(a.file === file));
  };
  const jumpToDef = (d: Definition) => {
    goTo(d.file, d.side, d.line, { word: { text: d.name, range: [d.start, d.end] } });
    view.say(`Definition of ${d.name} · ctrl-o to go back`);
  };
  // -- Language servers ------------------------------------------------------------

  /**
   * Where the cursor is, for a language server: they see files on disk, so
   * only the new side of a review of the working tree (and files opened for context).
   */
  const lspPosition = (): { path: string; line: number; word: WordAt } | null => {
    const c = view.cursor();
    const f = c ? files()[c.file] : undefined;
    const row = c && f ? f.rows[c.row] : undefined;
    if (!c || !f || !row || row[1] === null || c.side !== "new") return null;
    const range = review.range();
    if (review.meta().to !== null || (range !== null && range.to !== null && !review.isContext(c.file)))
      return null;
    const text = lineText(c);
    const word = c.word
      ? { text: c.word.text, col: c.word.range[0] }
      : (() => {
          const defs = review.definedNames();
          const words = [...text.matchAll(IDENT)];
          const m = words.find((w) => defs.has(w[0])) ?? words[0];
          return m ? { text: m[0], col: m.index } : null;
        })();
    return word ? { path: f.path, line: row[1] + 1, word } : null;
  };
  /** Open a place a language server pointed at: in the diff, the repository, or outside it. */
  const openLocation = async (l: CodeLocation, name: string) => {
    const file = await review.openContext(l.path);
    if (file === null) return view.say(`Can't open ${l.path}`);
    goTo(file, "new", l.line, { word: { text: name, range: [l.col, l.col + name.length] } });
    view.say(`${name} · ${l.path.split("/").pop()}:${l.line} · ctrl-o to go back`);
  };
  const goToLocations = (locations: readonly CodeLocation[], name: string, what: string) => {
    const [only] = locations;
    if (locations.length === 1 && only) return void openLocation(only, name);
    view.setPicker({
      title: `${locations.length} ${what} of ${name}`,
      items: () =>
        locations.map((l) => ({
          label: `${l.path.split("/").pop()}:${l.line}`,
          detail: l.path,
          run: () => void openLocation(l, name),
        })),
    });
  };
  /** `gd`: ask the language server; without one (or no answer), the diff's own symbol index. */
  const gotoDefinition = async (name?: string) => {
    const pos = lspPosition();
    const word = name ?? pos?.word.text ?? wordAtCursor();
    if (pos && (name === undefined || name === pos.word.text)) {
      const asking = review.ask("definition", pos.path, pos.line, pos.word.col);
      // A server that's starting or indexing can be slow; when the diff itself knows
      // the answer, don't keep the reader waiting for it.
      const known = word !== null && review.snapshot().symbols.some((s) => s.name === word);
      const answer = known ? await Promise.race([asking, wait(LSP_PATIENCE_MS)]) : await asking;
      if (answer && answer.type === "locations" && answer.locations.length > 0)
        return goToLocations(answer.locations, pos.word.text, "definitions");
    }
    symbolDefinition(word);
  };
  /** `gt`: the definition of the type of what's under the cursor (language servers only). */
  const typeDefinition = async () => {
    const pos = lspPosition();
    if (!pos) return view.say("Type definitions come from a language server: new side, working tree reviews");
    const answer = await review.ask("typeDefinition", pos.path, pos.line, pos.word.col);
    if (answer.type === "locations" && answer.locations.length > 0)
      return goToLocations(answer.locations, pos.word.text, "type definitions");
    view.say(answer.type === "unavailable" ? answer.reason : `No type definition for ${pos.word.text}`);
  };
  /** `K`: docs for what's under the cursor, and any diagnostics on its line. */
  const hoverAtCursor = async () => {
    const c = view.cursor();
    const el = cursorEl()?.querySelector<HTMLElement>(`.code[data-side="${c?.side ?? "new"}"]`);
    const pos = lspPosition();
    if (!c || !el) return;
    const f = files()[c.file];
    const diagnostics = pos && f ? diagnosticsOn(review.conv.diagnostics[f.path], pos.line) : [];
    const answer = pos ? await review.ask("hover", pos.path, pos.line, pos.word.col) : null;
    const markdown = answer?.type === "hover" ? answer.markdown : null;
    if (!markdown && diagnostics.length === 0)
      return view.say(answer?.type === "unavailable" ? answer.reason : "Nothing to show here");
    const word = pos ? textRange(el, pos.word.col, pos.word.col + pos.word.text.length) : null;
    const box = (word ?? el).getBoundingClientRect();
    view.setHover({
      key: `${pos?.path}:${pos?.line}:${pos?.word.col}`,
      markdown,
      diagnostics,
      at: { left: box.left, top: box.top, bottom: box.bottom },
    });
  };

  const symbolDefinition = (name: string | null) => {
    if (!name) return view.say("No symbol here · press w to pick one");
    const defs = rankDefs(review.snapshot().symbols.filter((s) => s.name === name));
    if (defs.length === 0) return view.say(`No definition of ${name} in this diff`);
    if (defs.length === 1 && defs[0]) return jumpToDef(defs[0]);
    view.setPicker({
      title: `Definitions of ${name}`,
      items: () =>
        defs.map((d) => ({ label: where(d.file, d.line, d.side), detail: d.kind, run: () => jumpToDef(d) })),
    });
  };
  const references = (name = wordAtCursor()) => {
    if (!name) return view.say("No symbol here · press w to pick one");
    const word = "[\\p{L}\\p{N}\\p{Mn}\\p{Mc}\\p{Pc}$]";
    const re = new RegExp(`(?<!${word})${name.replace(/\$/g, "\\$")}(?!${word})`, "u");
    const items: PickerItem[] = [];
    files().forEach((f, file) => {
      f.new?.lines.forEach((l, i) => {
        if (re.test(l))
          items.push({
            label: where(file, i + 1, "new"),
            detail: l.trim(),
            run: () => goTo(file, "new", i + 1),
          });
      });
      if (f.status === "deleted")
        f.old?.lines.forEach((l, i) => {
          if (re.test(l))
            items.push({
              label: where(file, i + 1, "old"),
              detail: l.trim(),
              run: () => goTo(file, "old", i + 1),
            });
        });
    });
    view.setPicker({ title: `${items.length} references to ${name}`, items: () => items });
  };
  const outline = (all: boolean) => {
    const file = view.cursor()?.file ?? 0;
    const syms = review.snapshot().symbols.filter((s) => all || s.file === file);
    view.setPicker({
      title: all ? "Symbols in this diff" : `Symbols in ${fileName(file)}`,
      items: () =>
        syms.map((s) => ({
          label: s.name,
          detail: `${s.kind} · ${where(s.file, s.line, s.side)}`,
          run: () => jumpToDef(s),
        })),
    });
  };
  // -- Commits -------------------------------------------------------------------

  /** Step through the commits one at a time; past either end is the whole review again. */
  const stepCommit = (dir: 1 | -1) => {
    const h = review.history();
    const n = steps(h);
    if (h.commits.length === 0) return view.say("This review has no commits to walk");
    const span = review.loadingSpan() ?? review.span();
    const next =
      span === null
        ? dir > 0
          ? 0
          : n - 1
        : span.to - span.from > 1
          ? dir > 0
            ? span.to - 1
            : span.from
          : span.from + dir;
    void review.showSpan(next >= 0 && next < n ? step(next) : null);
  };
  const commitPicker = () => {
    const h = review.history();
    if (h.commits.length === 0) return view.say("This review has no commits to walk");
    const items: PickerItem[] = [
      { label: "All changes", detail: `${h.commits.length} commits`, run: () => void review.showSpan(null) },
      ...h.commits.map((c, i) => ({
        label: c.subject,
        detail: `${c.short} · ${c.author}`,
        run: () => void review.showSpan(step(i)),
      })),
    ];
    if (h.worktree)
      items.push({
        label: "Uncommitted changes",
        detail: "working tree",
        run: () => void review.showSpan(step(h.commits.length)),
      });
    view.setPicker({ title: "Commits", items: () => items });
  };

  const filePicker = () =>
    view.setPicker({
      title: "Go to file",
      items: () => files().map((f, i) => ({ label: fileName(i), detail: f.path, run: () => openFile(i) })),
    });
  // -- Search (`/`, Ctrl+F, `n` / `N`) ------------------------------------------------

  /** Where the cursor is, for finding the match after or before it. */
  const searchPlace = (dir: 1 | -1, s: Search | null): SearchPlace => {
    const c = view.cursor();
    if (!c) return { file: dir > 0 ? -1 : files().length, row: 0, side: "old", col: 0 };
    // On the match last gone to: from that match. Anywhere else on a row: from the whole row.
    const cur = s?.matches[s.index];
    if (cur && cur.file === c.file && cur.row === c.row && cur.side === c.side)
      return { file: c.file, row: c.row, side: c.side, col: cur.start };
    return { file: c.file, row: c.row, side: c.side, col: dir > 0 ? -1 : Number.MAX_SAFE_INTEGER };
  };
  const showMatch = (s: Search, index: number, wrapped: boolean) => {
    const m = s.matches[index];
    if (!m) return;
    view.setSearch({ ...s, index });
    goTo(m.file, m.side, m.line);
    const more = s.matches.length >= MAX_MATCHES ? "+" : "";
    view.say(`/${s.query} · ${index + 1} of ${s.matches.length}${more}${wrapped ? " · wrapped around" : ""}`);
  };
  /** Search every line of both sides, folded ones too; Enter goes to the first match after the cursor. */
  const search = () => {
    let last: Search | null = null;
    const run = (q: string): Search => {
      if (last?.query !== q || last.snapshot !== review.snapshot())
        last = {
          query: q,
          snapshot: review.snapshot(),
          matches: findMatches(files(), review.models(), q),
          index: -1,
        };
      return last;
    };
    view.setPicker({
      title: "Search every line, hidden ones too",
      literal: true,
      status: (q) => {
        if (q.length < 2) return "";
        const n = run(q).matches.length;
        return n === 0
          ? "No matches"
          : `${n}${n >= MAX_MATCHES ? "+" : ""} match${n === 1 ? "" : "es"} · n / N next and previous`;
      },
      items: (q) => {
        if (q.length < 2) return [];
        const s = run(q);
        // From the next match after the cursor, round to the one before it.
        const { index: first } = nextMatch(s.matches, searchPlace(1, null), 1);
        const out: PickerItem[] = [];
        for (let k = 0; k < Math.min(300, s.matches.length); k++) {
          const i = (first + k) % s.matches.length;
          const m = s.matches[i] as Match;
          out.push({
            label: where(m.file, m.line, m.side),
            detail:
              (m.side === "old" ? files()[m.file]?.old : files()[m.file]?.new)?.lines[m.line - 1]?.trim() ??
              "",
            run: () => showMatch(s, i, false),
          });
        }
        return out;
      },
    });
  };
  /** `n` / `N`: the next or previous match of the last search. */
  const searchNext = (dir: 1 | -1) => {
    const prev = view.search();
    if (!prev) return view.say("Nothing searched yet · / or ctrl-f to search");
    const s =
      prev.snapshot === review.snapshot()
        ? prev
        : {
            query: prev.query,
            snapshot: review.snapshot(),
            matches: findMatches(files(), review.models(), prev.query),
            index: -1,
          };
    const { index, wrapped } = nextMatch(s.matches, searchPlace(dir, s), dir);
    if (index < 0) {
      view.setSearch(s);
      return view.say(`/${s.query} · no matches`);
    }
    showMatch(s, index, wrapped);
  };

  // -- Comments ------------------------------------------------------------------

  const anchorFrom = (file: number, side: Side, start: number, end: number) => {
    const f = files()[file];
    const text = side === "old" ? f?.old : f?.new;
    if (!f || !text) return null;
    const quote = text.lines.slice(start - 1, end).join("\n");
    // On part of the history, the server finds the same code in the whole diff by its text.
    const range = review.isContext(file) ? null : review.range();
    return { anchor: { path: f.path, side, start, end, text: quote, range }, quote };
  };
  const openComposer = (file: number, side: Side, start: number, end: number) => {
    const a = anchorFrom(file, side, start, end);
    if (!a) return;
    view.setVisual(null);
    view.setComposer({ kind: "new", ...a });
    review.drafting(true);
  };
  /** `gcc`, or `gc` in visual mode: comment on the cursor line or selected lines. */
  const comment = () => {
    const c = view.cursor();
    if (!c) return view.say("Put the cursor on a line first");
    const lineOf = (row: number) => {
      const r = files()[c.file]?.rows[row];
      const l = r ? (c.side === "old" ? r[0] : r[1]) : null;
      return l === null || l === undefined ? null : l + 1;
    };
    const v = view.visual();
    const rows = v && v.file === c.file ? [v.row, c.row] : [c.row];
    const lines = [...new Set(rowsBetween(Math.min(...rows), Math.max(...rows)).map(lineOf))].filter(
      (l): l is number => l !== null,
    );
    if (lines.length === 0) return view.say(`No ${c.side} lines selected`);
    openComposer(c.file, c.side, Math.min(...lines), Math.max(...lines));
  };
  // -- Text objects (visual mode) --------------------------------------------------

  /** `vip`, `vaf`, `vi{`, …: select the lines of a text object around the cursor. */
  const selectObject = (object: TextObject, around: boolean) => {
    const c = view.cursor();
    const f = c ? files()[c.file] : undefined;
    const model = c ? review.models()[c.file] : undefined;
    const side = c && f ? (c.side === "old" ? f.old : f.new) : null;
    const rowLine = c && f ? f.rows[c.row]?.[c.side === "old" ? 0 : 1] : null;
    if (!c || !f || !model || !side || rowLine === null || rowLine === undefined)
      return view.say("Put the cursor on a line of code first");
    const line = rowLine + 1;
    const text = side.lines;
    const col = c.word?.range[0] ?? Math.max(0, (text[line - 1] ?? "").search(/\S/));
    const spans = review.snapshot().symbols.filter((s) => s.file === c.file && s.side === c.side);
    const lines = match(object)
      .with("paragraph", () => paragraph(text, line, around))
      .with("function", () => definition(spans, FUNCTION_KINDS, line, around))
      .with("class", () => definition(spans, CLASS_KINDS, line, around))
      .with("brace", () => pair(text, line, col, "{", "}", around))
      .with("paren", () => pair(text, line, col, "(", ")", around))
      .with("bracket", () => pair(text, line, col, "[", "]", around))
      .with("tag", () => tag(text, line, around))
      .with("hunk", () => hunkLines(c.file, c.row, c.side, around))
      .exhaustive();
    if (!lines) return view.say(`No ${object} around this line`);
    const first = rowOf(model, c.side, lines[0]);
    const last = rowOf(model, c.side, lines[1]);
    if (first < 0 || last < 0) return;
    ensureRow(c.file, first);
    ensureRow(c.file, last);
    view.setVisual({ file: c.file, row: first });
    placeRow(c.file, last, { side: c.side });
  };
  /** The run of changed rows around a row, as lines of one side; `ah` takes a line of context on each end. */
  const hunkLines = (file: number, row: number, side: Side, around: boolean): LineRange | null => {
    const f = files()[file];
    if (!f) return null;
    const changed = (r: number) => {
      const x = f.rows[r];
      return x !== undefined && rowChanged(f, x);
    };
    if (!changed(row)) return null;
    let a = row;
    let b = row;
    while (a > 0 && changed(a - 1)) a--;
    while (b < f.rows.length - 1 && changed(b + 1)) b++;
    if (around) {
      a = Math.max(0, a - 1);
      b = Math.min(f.rows.length - 1, b + 1);
    }
    const lineOf = (r: number) => f.rows[r]?.[side === "old" ? 0 : 1] ?? null;
    // The first and last rows that have this side.
    let first: number | null = null;
    let last: number | null = null;
    for (let r = a; r <= b; r++) {
      const l = lineOf(r);
      if (l === null) continue;
      first ??= l + 1;
      last = l + 1;
    }
    return first === null || last === null ? null : [first, last];
  };

  const rowsBetween = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

  /** `gc` with a mouse selection: comment on the selected lines. */
  const commentSelection = (): boolean => {
    const s = view.selection();
    if (!s) return false;
    getSelection()?.removeAllRanges();
    view.setSelection(null);
    openComposer(s.file, s.side, s.start, s.end);
    return true;
  };

  const replyTo = (thread: Thread) => {
    const label = `${fileName(review.paths().indexOf(thread.anchor.path))}:${thread.anchor.start}`;
    view.setComposer({ kind: "reply", threadId: thread.id, label });
    review.drafting(true);
  };
  const nearThread = (): Thread | undefined => {
    const at = cursorIndex();
    const all = threadsInOrder();
    return (all.find((t) => at < 0 || t.index > at) ?? all.at(-1))?.thread;
  };
  const closeComposer = () => {
    if (!view.composer()) return;
    view.setComposer(null);
    review.drafting(false);
    bufferEl()?.focus({ preventScroll: true });
  };
  const sendComposer = (body: string) => {
    const c = view.composer();
    const text = body.trim();
    if (!c || !text) return;
    match(c)
      .with({ kind: "new" }, ({ anchor }) => review.comment(anchor, text))
      .with({ kind: "reply" }, ({ threadId }) => review.reply(threadId, text))
      .exhaustive();
    closeComposer();
  };

  // -- The agent pointing at things -----------------------------------------

  const showRequest = async (req: ShowRequest) => {
    // The agent can show any file in the repository, not only the diff.
    const file = await review.openContext(req.path);
    if (file !== null) goTo(file, req.side, req.start);
  };
  /** Go to a line of any file, by path (links in Markdown). */
  const openPathAt = async (path: string, line: number) => {
    const file = await review.openContext(path);
    if (file !== null) goTo(file, "new", line);
  };
  /** Open a file outside the diff (from the tree) in file view. */
  const openPath = async (path: string) => {
    const file = await review.openContext(path);
    if (file !== null) openFile(file);
  };
  const nudgeDone = (go: boolean) => {
    const req = view.nudge();
    view.setNudge(null);
    if (req && go) showRequest(req);
  };

  // -- Misc ----------------------------------------------------------------------

  const toggleDrawer = (side: "left" | "right") => view.setDrawers(side, "collapsed", (c) => !c);
  /** The chat lives in the right drawer: open it if needed. */
  const focusChat = () => {
    view.setDrawers("right", "collapsed", false);
    queueMicrotask(() => document.getElementById("chat-input")?.focus());
  };
  const markViewedAndNext = () => {
    const mode = view.mode();
    const file = mode.kind === "file" ? mode.file : view.cursor()?.file;
    if (file === undefined) return;
    const path = files()[file]?.path ?? "";
    const viewed = !view.flags.viewed[path];
    setViewed(file, viewed);
    if (viewed) fileJump(1);
  };
  const escapeAll = () => {
    if (view.help()) return view.setHelp(false);
    if (view.nudge()) return nudgeDone(false);
    if (view.composer()) return closeComposer();
    if (view.visual()) return view.setVisual(null);
    const c = view.cursor();
    if (c?.word) return view.setCursor({ ...c, word: null });
    if (view.search()) view.setSearch(null);
    getSelection()?.removeAllRanges();
  };
  const startVisual = () => {
    const c = view.cursor();
    if (!c) return;
    view.setVisual({ file: c.file, row: c.row });
    view.setCursor({ ...c, word: null });
  };

  return {
    place,
    placeRow,
    startAtFirstChange,
    move,
    edge,
    halfPage,
    switchSide,
    stepWord,
    hunk,
    fileJump,
    openFile,
    noteJump,
    threadJump,
    activityGo,
    chapterJump,
    chapterGo,
    unreadNext,
    goTo,
    goToThread,
    expand,
    expandNearest,
    expandAround,
    contractAround,
    toggleFold,
    setViewed,
    expandAll,
    collapseAll,
    fileView,
    gotoDefinition,
    references,
    outline,
    filePicker,
    selectObject,
    typeDefinition,
    hoverAtCursor,
    openPath,
    openPathAt,
    splitPane,
    closePane,
    focusSplit,
    fileInSplit,
    setMark,
    jumpToMark,
    deleteMark,
    stepCommit,
    commitPicker,
    search,
    searchNext,
    jumpBack,
    jumpForward,
    comment,
    openComposer,
    commentSelection,
    replyTo,
    nearThread,
    closeComposer,
    sendComposer,
    showRequest,
    nudgeDone,
    toggleDrawer,
    focusChat,
    markViewedAndNext,
    escapeAll,
    startVisual,
  };
}

export type Commands = ReturnType<typeof createCommands>;
