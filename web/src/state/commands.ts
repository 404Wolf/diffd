/**
 * Everything the user can do, written once and bound to keys, clicks and
 * server events alike.
 */
import { batch } from "solid-js";
import { match } from "ts-pattern";
import type { ActivityItem } from "../gen/ActivityItem";
import type { ShowRequest } from "../gen/ShowRequest";
import type { Side } from "../gen/Side";
import type { Symbol as Definition } from "../gen/Symbol";
import type { Thread } from "../gen/Thread";
import { type ExpandDirection, expandGap, initialVisible, nearestGap, rowOf } from "../lib/diffModel";
import { buildTree, treeOrder } from "../lib/tree";
import {
  bufferEl,
  flash,
  follows,
  keepViewport,
  navigableRows,
  readingPosition,
  restoreReadingPosition,
  reveal,
  rowEl,
} from "./dom";
import { fromAgent, type Review } from "./review";
import { CONTEXT, type Cursor, EXPAND_STEP, type PickerItem, type Place, type View, type Word } from "./view";

const IDENT = /[A-Za-z_$][\w$]*/g;

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

  /** Put the cursor on a rendered row, keeping the side when that side exists there. */
  const place = (
    el: HTMLElement,
    opts: { side?: Side; word?: Word | null; scroll?: "nearest" | "center" | false } = {},
  ) => {
    const file = Number(el.dataset.f);
    const row = Number(el.dataset.r);
    const has = (s: Side) => el.querySelector(`.code[data-side="${s}"]`) !== null;
    const current = view.cursor()?.side ?? "new";
    const side =
      opts.side && has(opts.side) ? opts.side : has(current) ? current : current === "new" ? "old" : "new";
    view.setCursor({ file, row, side, word: opts.word ?? null });
    if (opts.scroll !== false) reveal(el, opts.scroll ?? "nearest");
  };

  const move = (delta: number) => {
    const rows = navigableRows();
    if (rows.length === 0) return;
    const cur = cursorEl();
    const at = cur ? rows.indexOf(cur) : -1;
    const next = rows[at < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, at + delta))];
    if (next) place(next);
  };
  const edge = (last: boolean) => {
    const rows = navigableRows();
    const el = last ? rows.at(-1) : rows[0];
    if (!el) return;
    remember();
    place(el, { scroll: "center" });
  };
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
    const el = cursorEl();
    if (el?.querySelector(`.code[data-side="${other}"]`)) view.setCursor({ ...c, side: other, word: null });
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

  const hunkStarts = (): HTMLElement[] => {
    const rows = navigableRows();
    return rows.filter((r, k) => {
      const prev = rows[k - 1];
      return r.dataset.chg === "1" && (prev?.dataset.chg !== "1" || prev.dataset.f !== r.dataset.f);
    });
  };
  const hunk = (dir: 1 | -1) => {
    const cur = cursorEl();
    const starts = hunkStarts();
    const target =
      dir > 0
        ? starts.find((h) => !cur || follows(cur, h))
        : [...starts].reverse().find((h) => cur && follows(h, cur));
    if (!target) return view.say(dir > 0 ? "No more hunks below" : "No more hunks above");
    remember();
    place(target, { scroll: "center" });
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

  const goTo = (file: number, side: Side, line: number, opts: { word?: Word | null; card?: string } = {}) => {
    const model = review.models()[file];
    if (!model) return;
    const row = rowOf(model, side, line);
    if (row < 0) return view.say(`Line ${line} isn't in ${fileName(file)}`);
    remember();
    const m = view.mode();
    if (m.kind === "file" && m.file !== file) view.setMode({ kind: "diff" });
    if (view.mode().kind === "diff") ensureRow(file, row);
    const el = rowEl(file, row);
    if (!el) return;
    place(el, { side, word: opts.word ?? null, scroll: "center" });
    flash(el);
    if (opts.card) {
      const card = document.getElementById(opts.card);
      if (card) {
        card.scrollIntoView({ block: "nearest" });
        card.classList.add("ring-2", "ring-accent");
        setTimeout(() => card.classList.remove("ring-2", "ring-accent"), 1600);
      }
    }
  };
  const goToThread = (t: Thread) => {
    const file = review.paths().indexOf(t.anchor.path);
    if (file >= 0) goTo(file, t.anchor.side, t.anchor.end, { card: `thread-${t.id}` });
  };

  const order = () => treeOrder(buildTree(review.paths()));
  const openFile = (file: number, rememberIt = true) => {
    if (rememberIt) remember();
    const m = view.mode();
    if (m.kind === "file") {
      view.setMode({ kind: "file", file });
      bufferEl()?.scrollTo({ top: 0 });
      return;
    }
    unhide(file);
    const section = document.getElementById(`file-${file}`);
    const buf = bufferEl();
    if (!section || !buf) return;
    buf.scrollTop += section.getBoundingClientRect().top - buf.getBoundingClientRect().top - 6;
    const first =
      section.querySelector<HTMLElement>('.row[data-chg="1"]') ?? section.querySelector<HTMLElement>(".row");
    if (first) place(first, { scroll: false });
  };
  /** `]f` / `[f`, in tree order, skipping collapsed and viewed files. */
  const fileJump = (dir: 1 | -1) => {
    const list = order();
    const current =
      view.mode().kind === "file"
        ? (view.mode() as { file: number }).file
        : (view.cursor()?.file ?? list[0] ?? 0);
    let at = list.indexOf(current);
    for (;;) {
      at += dir;
      const next = list[at];
      if (next === undefined)
        return view.say(dir > 0 ? "No more open files below" : "No more open files above");
      if (!view.hidden(next)) return openFile(next);
    }
  };

  const noteJump = (dir: 1 | -1) => {
    const notes = review.notes();
    const idx = view.noteIndex() < 0 && dir > 0 ? 0 : view.noteIndex() + dir;
    const note = notes[idx];
    if (!note) return view.say(dir > 0 ? "That was the last note" : "That was the first note");
    view.setNoteIndex(idx);
    goToThread(note);
  };

  const threadJump = (dir: 1 | -1) => {
    const cards = [...(bufferEl()?.querySelectorAll<HTMLElement>("[data-thread]") ?? [])];
    const cur = cursorEl();
    const card =
      dir > 0
        ? cards.find((c) => !cur || follows(cur, c))
        : [...cards].reverse().find((c) => cur && follows(c, cur));
    const t = review.conv.threads.find((x) => x.id === card?.dataset.thread);
    if (!t) return view.say("No more threads that way");
    goToThread(t);
  };

  const activityGo = (item: ActivityItem) => {
    review.markRead(item.seq);
    match(item.kind)
      .with({ type: "userCommented" }, { type: "agentReplied" }, { type: "agentNoted" }, ({ threadId }) => {
        const t = review.conv.threads.find((x) => x.id === threadId);
        if (t) goToThread(t);
      })
      .with({ type: "revision" }, ({ paths }) => {
        const file = review.paths().indexOf(paths[0] ?? "");
        if (file >= 0) openFile(file);
      })
      .with({ type: "show" }, ({ request }) => showRequest(request))
      .with({ type: "agentSaid" }, () => document.getElementById("chat-input")?.focus())
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

  const toggleFold = (file: number) => {
    const path = files()[file]?.path;
    if (!path) return;
    const header = () => document.querySelector(`#file-${file} [data-file-head]`);
    const before = header()?.getBoundingClientRect().top ?? 0;
    const open = view.hidden(file);
    batch(() => {
      view.setFlags("collapsed", path, !open);
      if (open) view.setFlags("viewed", path, false);
    });
    const buf = bufferEl();
    const after = header()?.getBoundingClientRect().top;
    if (buf && after !== undefined) buf.scrollTop += after - before;
  };

  const setViewed = (file: number, viewed: boolean) => {
    const path = files()[file]?.path;
    if (!path) return;
    const header = () => document.querySelector(`#file-${file} [data-file-head]`);
    const before = header()?.getBoundingClientRect().top ?? 0;
    view.setFlags("viewed", path, viewed);
    const buf = bufferEl();
    const after = header()?.getBoundingClientRect().top;
    if (buf && after !== undefined) buf.scrollTop += after - before;
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
    const el = rowEl(c.file, c.row) ?? bufferEl()?.querySelector<HTMLElement>(".row") ?? null;
    if (el) place(el, { scroll: "center" });
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
  const gotoDefinition = (name = wordAtCursor()) => {
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
    const re = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`);
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
  const filePicker = () =>
    view.setPicker({
      title: "Go to file",
      items: () => files().map((f, i) => ({ label: fileName(i), detail: f.path, run: () => openFile(i) })),
    });
  const search = () =>
    view.setPicker({
      title: "Search every line, hidden ones too",
      literal: true,
      items: (q) => {
        if (q.length < 2) return [];
        const needle = q.toLowerCase();
        const out: PickerItem[] = [];
        files().forEach((f, file) => {
          for (const [side, text] of [
            ["new", f.new],
            ["old", f.old],
          ] as const) {
            text?.lines.forEach((l, i) => {
              if (out.length < 300 && l.toLowerCase().includes(needle))
                out.push({
                  label: where(file, i + 1, side),
                  detail: l.trim(),
                  run: () => goTo(file, side, i + 1),
                });
            });
          }
        });
        return out;
      },
    });

  // -- Comments ------------------------------------------------------------------

  const anchorFrom = (file: number, side: Side, start: number, end: number) => {
    const f = files()[file];
    const text = side === "old" ? f?.old : f?.new;
    if (!f || !text) return null;
    return {
      anchor: { path: f.path, side, start, end, text: "" },
      quote: text.lines.slice(start - 1, end).join("\n"),
    };
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
    if (!c || view.mode().kind !== "diff")
      return view.say("Comments go on diff lines · move the cursor onto one");
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
    const cards = [...(bufferEl()?.querySelectorAll<HTMLElement>("[data-thread]") ?? [])];
    const cur = cursorEl();
    const card = cards.find((c) => !cur || follows(cur, c)) ?? cards.at(-1);
    return review.conv.threads.find((t) => t.id === card?.dataset.thread);
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

  const showRequest = (req: ShowRequest) => {
    const file = review.paths().indexOf(req.path);
    if (file >= 0) goTo(file, req.side, req.start);
  };
  const nudgeDone = (go: boolean) => {
    const req = view.nudge();
    view.setNudge(null);
    if (req && go) showRequest(req);
  };

  // -- Misc ----------------------------------------------------------------------

  const toggleDrawer = (side: "left" | "right") => view.setDrawers(side, "collapsed", (c) => !c);
  const markViewedAndNext = () => {
    const file = view.mode().kind === "file" ? (view.mode() as { file: number }).file : view.cursor()?.file;
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
    unreadNext,
    goTo,
    goToThread,
    expand,
    expandNearest,
    toggleFold,
    setViewed,
    expandAll,
    collapseAll,
    fileView,
    gotoDefinition,
    references,
    outline,
    filePicker,
    search,
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
    markViewedAndNext,
    escapeAll,
    startVisual,
    fromAgent,
  };
}

export type Commands = ReturnType<typeof createCommands>;
