import {
  createEffect,
  createMemo,
  createRenderEffect,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { match } from "ts-pattern";
import { columnAtPoint, wordAt } from "../lib/code";
import { changeMarks, fileViewRowHtml, lineHtml } from "../lib/render";
import { wrappedLines } from "../lib/windower";
import type { Commands } from "../state/commands";
import { bufferEl, rowEl, rowsRenderedEvent } from "../state/dom";
import { createFileLayout, type Item, type LayoutState } from "../state/layout";
import type { Review } from "../state/review";
import type { Pane, View } from "../state/view";
import { ContextMenu, type MenuAt } from "./ContextMenu";
import { useMouseHover } from "./Hover";
import { CODE_PAD_PX, Multibuffer, ROW_PX } from "./Multibuffer";
import { ThreadCard } from "./ThreadCard";
import { WindowedList } from "./WindowedList";

/** File view's card: its side margins and borders, and its change mark and line number columns. */
const FV_INSET_PX = 20 + 2;
const FV_GUTTER_PX = 5 + 46;

interface Props {
  review: Review;
  view: View;
  cmd: Commands;
  layout: LayoutState;
  /** The split this buffer shows. */
  pane: Pane;
}

/** The scrolling area: every file as excerpts (the windowed multibuffer), or one plain file (file view). */
export function Buffer(props: Props) {
  usePaintCursor(props);
  let main: HTMLElement | undefined;
  useMouseHover(props, () => main);

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    // `path:line` links are handled for the whole page (ReviewPage).
    if (target.closest("[data-go]")) return;
    const row = target.closest<HTMLElement>(".row");
    if (!row) return;
    const num = target.closest<HTMLElement>(".num[data-n]");
    const code = target.closest<HTMLElement>(".code[data-side]");
    const side = (num?.dataset.side ?? code?.dataset.side) as "old" | "new" | undefined;
    if (!side) return;
    const selection = getSelection();
    if (selection && !selection.isCollapsed) return;
    if (num) {
      // Clicking a line number starts a comment there; shift-click extends from the cursor.
      const line = Number(num.dataset.n);
      const file = Number(row.dataset.f);
      const cur = props.pane.cursor();
      const key = side === "old" ? "ol" : "nl";
      const from =
        cur && cur.file === file && cur.side === side
          ? Number(rowEl(cur.file, cur.row, bufferEl(props.pane.id))?.dataset[key] || line)
          : line;
      if (!e.shiftKey) props.cmd.place(row, { side, scroll: false });
      props.cmd.openComposer(file, side, Math.min(from, line), Math.max(from, line));
      return;
    }
    const ref = target.closest<HTMLElement>(".ref");
    let word = null;
    if (ref && code) {
      const range = document.createRange();
      range.setStart(code, 0);
      range.setEndBefore(ref);
      const at = range.toString().length;
      word = { text: ref.textContent ?? "", range: [at, at + (ref.textContent?.length ?? 0)] as const };
    }
    props.cmd.place(row, { side, word, scroll: false });
    if (word && (e.ctrlKey || e.metaKey)) void props.cmd.gotoDefinition(word.text);
  };

  // Right-click on code: the language-server actions for what's under the pointer.
  // Shift+right-click, or right-clicking a selection, keeps the browser's own menu.
  const [menu, setMenu] = createSignal<MenuAt | null>(null);
  const onContextMenu = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>(".row");
    const cell = target.closest<HTMLElement>(".code[data-side], .num[data-side]");
    const selection = getSelection();
    if (!row || !cell || e.shiftKey || (selection && !selection.isCollapsed)) return;
    e.preventDefault();
    const side = cell.dataset.side as "old" | "new";
    const code = cell.classList.contains("code") ? cell : null;
    const col = code ? columnAtPoint(code, e.clientX, e.clientY) : null;
    const hit = code && col !== null ? wordAt(code.textContent ?? "", col) : null;
    const word = hit ? { text: hit.text, range: [hit.col, hit.col + hit.text.length] as const } : null;
    props.cmd.place(row, { side, word, scroll: false });
    setMenu({ x: e.clientX, y: e.clientY, word: hit?.text ?? null });
  };

  return (
    // Clicks are delegated from static rows; every click action also has a key binding.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard equivalents live in state/bindings.ts
    <section
      ref={main}
      aria-label={
        props.view.panes().length > 1 ? `Split ${props.view.panes().indexOf(props.pane) + 1}` : "The diff"
      }
      id={`buffer-${props.pane.id}`}
      data-pane={props.pane.id}
      tabindex="-1"
      class="buffer min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain bg-inset pb-6 outline-none [overflow-anchor:none]"
      classList={{ sym: props.view.symKey(), focused: props.view.focused().id === props.pane.id }}
      onPointerDown={() => props.view.focusPane(props.pane.id)}
      onFocusIn={() => props.view.focusPane(props.pane.id)}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <ContextMenu at={menu()} cmd={props.cmd} onClose={() => setMenu(null)} />
      <Show
        // An object, not the index: `Show` treats file 0 as false.
        when={match(props.pane.mode())
          .with({ kind: "file" }, (m) => m)
          .otherwise(() => null)}
        fallback={
          <Multibuffer
            review={props.review}
            view={props.view}
            cmd={props.cmd}
            layout={props.layout}
            pane={props.pane}
            buf={() => main}
          />
        }
      >
        {(m) => (
          <FileView
            file={m().file}
            review={props.review}
            view={props.view}
            cmd={props.cmd}
            pane={props.pane}
            buf={() => main}
          />
        )}
      </Show>
    </section>
  );
}

/**
 * `g enter`: the plain file, with slight marks where it changed, and its
 * threads inline. Windowed like the multibuffer, so a huge file opens at once.
 */
function FileView(props: {
  file: number;
  review: Review;
  view: View;
  cmd: Commands;
  pane: Pane;
  buf: () => HTMLElement | undefined;
}) {
  const f = () => props.review.snapshot().files[props.file];
  const context = () => props.review.isContext(props.file);
  const nav = createFileLayout(props.review, () => props.file);
  const text = () => (nav.side() === "new" ? f()?.new : f()?.old);
  const marks = createMemo(() => {
    const file = f();
    return file && !context() ? changeMarks(file, nav.side()) : [];
  });
  /** Characters per line of code, for estimating how lines wrap. */
  let columns = 80;
  const onWidth = (width: number, charWidth: number) => {
    columns = Math.max(8, Math.floor((width - FV_INSET_PX - FV_GUTTER_PX - CODE_PAD_PX) / charWidth));
  };
  const lineOf = (row: number) => {
    const r = f()?.rows[row];
    return r ? (nav.side() === "new" ? r[1] : r[0]) : null;
  };
  const estimate = (item: Item): number =>
    match(item)
      .with({ kind: "row" }, ({ row }) => {
        const line = lineOf(row);
        return ROW_PX * (line === null ? 1 : wrappedLines(text()?.lines[line] ?? "", columns));
      })
      .with({ kind: "threads" }, ({ row }) => 14 + 90 * nav.threadsAt(props.file, row).length)
      .otherwise(() => ROW_PX);
  const render = (item: Item): JSX.Element =>
    match(item)
      .with({ kind: "row" }, ({ row }) => {
        const el = document.createElement("div");
        createRenderEffect(() => {
          const line = lineOf(row);
          const t = text();
          el.innerHTML =
            line === null || !t
              ? ""
              : fileViewRowHtml(
                  props.file,
                  row,
                  nav.side(),
                  line,
                  t,
                  marks()[line] ?? "",
                  props.review.definedNames(),
                );
        });
        return el;
      })
      .with({ kind: "threads" }, ({ row }) => (
        <div class="border-y border-line bg-inset py-1.5 pl-[51px]">
          <For each={nav.threadsAt(props.file, row)}>
            {(t) => (
              <div class="mr-2.5">
                <ThreadCard thread={t} review={props.review} cmd={props.cmd} />
              </div>
            )}
          </For>
        </div>
      ))
      .otherwise(() => <div />);
  return (
    <>
      <div class="mx-2.5 mt-2.5 flex flex-wrap items-center gap-2 rounded-md border border-line-strong bg-bg px-2.5 py-1.5 text-xs text-muted">
        <b class="font-mono font-semibold text-fg">{f()?.path}</b>
        <Show
          when={context()}
          fallback={
            <>
              <span>the file at revision {props.review.meta().revision}, no diff</span>
              <span class="flex-1" />
              <Legend color="var(--add-mark)" label="added" />
              <Legend color="var(--mod-mark)" label="changed" />
              <Legend color="var(--del-mark)" label="removed" />
            </>
          }
        >
          <span>not changed in this review · opened for context</span>
          <span class="flex-1" />
        </Show>
        <span>
          <kbd>ctrl</kbd> <kbd>o</kbd> back
        </span>
      </div>
      <section class="fv mx-2.5 my-2 overflow-clip rounded-md border border-line-strong bg-bg">
        <WindowedList
          pane={props.pane}
          buf={props.buf}
          nav={nav}
          estimate={estimate}
          onWidth={onWidth}
          render={render}
          topInset={0}
        />
      </section>
    </>
  );
}

function Legend(props: { color: string; label: string }) {
  return (
    <span class="inline-flex items-center gap-1">
      <i class="inline-block h-3 w-1 rounded-sm" style={{ background: props.color }} />
      {props.label}
    </span>
  );
}

/**
 * Draw the cursor, visual selection and symbol cursor onto the static rows.
 * Rows are plain HTML, so this touches a handful of elements per move.
 */
function usePaintCursor(props: Props) {
  let painted: {
    rows: HTMLElement[];
    caret?: HTMLElement | null;
    word: { el: HTMLElement; html: string } | null;
  } = {
    rows: [],
    word: null,
  };
  let repaint = () => {};
  createEffect(() => {
    const cursor = props.pane.cursor();
    const visual = props.pane.visual();
    // Re-paint after anything that re-renders rows.
    props.pane.mode();
    props.review.snapshot();
    props.review.threads().length;
    for (let i = 0; i < props.review.snapshot().files.length; i++) props.view.visible(i);
    repaint = () => {
      for (const el of painted.rows) el.classList.remove("cur", "vsel");
      painted.caret?.classList.remove("caret");
      if (painted.word?.el.isConnected) painted.word.el.innerHTML = painted.word.html;
      painted = { rows: [], word: null };
      if (!cursor) return;
      const buf = bufferEl(props.pane.id);
      const row = rowEl(cursor.file, cursor.row, buf);
      if (!row) return;
      row.classList.add("cur");
      painted.rows.push(row);
      const code =
        row.querySelector<HTMLElement>(`.code[data-side="${cursor.side}"]`) ??
        row.querySelector<HTMLElement>(".code[data-side]");
      code?.classList.add("caret");
      painted.caret = code;
      if (cursor.word && code) {
        const file = props.review.snapshot().files[cursor.file];
        const r = file?.rows[cursor.row];
        const side = code.dataset.side === "old" ? file?.old : file?.new;
        const line = r ? (code.dataset.side === "old" ? r[0] : r[1]) : null;
        if (side && line !== null && line !== undefined) {
          painted.word = { el: code, html: code.innerHTML };
          const inDiff = props.pane.mode().kind === "diff";
          code.innerHTML = lineHtml(
            side.lines[line] ?? "",
            side.syntax[line],
            inDiff ? side.novel[line] : undefined,
            {
              novelClass: inDiff ? (code.dataset.side === "old" ? "nv-del" : "nv-add") : null,
              refs: props.review.definedNames(),
              word: cursor.word.range,
            },
          );
        }
      }
      if (visual && visual.file === cursor.file) {
        const [a, b] = [Math.min(visual.row, cursor.row), Math.max(visual.row, cursor.row)];
        for (let r = a; r <= b; r++) {
          const el = rowEl(cursor.file, r, buf);
          if (el) {
            el.classList.add("vsel");
            painted.rows.push(el);
          }
        }
      }
    };
    queueMicrotask(repaint);
  });
  // Rows can be rebuilt from HTML for other reasons (marks, notes, lazy fills): paint again.
  onMount(() => {
    const again = () => repaint();
    document.addEventListener(rowsRenderedEvent, again);
    onCleanup(() => document.removeEventListener(rowsRenderedEvent, again));
  });
}
