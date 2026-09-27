import { createEffect, createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import { match } from "ts-pattern";
import type { Thread } from "../gen/Thread";
import { columnAtPoint, wordAt } from "../lib/code";
import { rowOf } from "../lib/diffModel";
import { rowsRenderedEvent } from "../lib/lazyRows";
import { changeMarks, fileViewRowHtml, lineHtml } from "../lib/render";
import type { Commands } from "../state/commands";
import { bufferEl, rowEl } from "../state/dom";
import type { Review } from "../state/review";
import type { Pane, View } from "../state/view";
import { ContextMenu, type MenuAt } from "./ContextMenu";
import { FileSection } from "./FileSection";
import { useMouseHover } from "./Hover";
import { Markdown } from "./Markdown";
import { ThreadCard } from "./ThreadCard";

interface Props {
  review: Review;
  view: View;
  cmd: Commands;
  /** The split this buffer shows. */
  pane: Pane;
}

/** The scrolling area: every file as excerpts (the multibuffer), or one plain file (file view). */
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
          <>
            <Summary review={props.review} cmd={props.cmd} />
            {/* Index, not For: sections stay put across revisions and only their contents update. */}
            <Index each={props.review.snapshot().files}>
              {(_, i) => (
                // Files opened for context aren't part of the diff: they only show in file view.
                <Show when={!props.review.isContext(i)}>
                  <Show when={props.review.groupAt(props.review.paths()[i] ?? "")}>
                    {(g) => (
                      <header class="mx-2.5 mt-4 mb-1 first:mt-2" data-group={g().title}>
                        <h2 class="text-[13px] font-semibold text-fg">{g().title}</h2>
                        <Show when={g().summary}>
                          <p class="text-xs text-muted">{g().summary}</p>
                        </Show>
                      </header>
                    )}
                  </Show>
                  <FileSection index={i} review={props.review} view={props.view} cmd={props.cmd} />
                </Show>
              )}
            </Index>
            <Show when={props.review.diffCount() === 0}>
              <p class="p-6 text-center text-muted">
                {props.review.hiddenCount() > 0
                  ? `All ${props.review.hiddenCount()} files are hidden by labels; show them from the files drawer.`
                  : "No changes between these revisions."}
              </p>
            </Show>
          </>
        }
      >
        {(m) => <FileView file={m().file} review={props.review} view={props.view} cmd={props.cmd} />}
      </Show>
    </section>
  );
}

function Summary(props: { review: Review; cmd: Commands }) {
  return (
    <Show when={props.review.meta().summary || props.review.notes().length > 0}>
      <div class="mx-2 mt-2 mb-0.5 rounded-md border border-accent-line bg-bg px-2.5 py-1.5 text-[12.5px]">
        <Show when={props.review.meta().summary}>
          {(summary) => (
            <div class="flex gap-2">
              <b class="shrink-0 font-semibold text-accent">✦ Summary</b>
              <Markdown text={summary()} paths={props.review.paths()} class="max-w-[90ch]" />
            </div>
          )}
        </Show>
        <Show when={props.review.notes().length > 0}>
          <button
            type="button"
            class="mt-1 cursor-pointer text-[11.5px] text-muted hover:text-fg"
            onClick={() => props.cmd.noteJump(1)}
          >
            Walk through {props.review.notes().length} note{props.review.notes().length === 1 ? "" : "s"}{" "}
            <kbd>]a</kbd>
          </button>
        </Show>
      </div>
    </Show>
  );
}

/** `g enter`: the plain file, with slight marks where it changed, and its threads inline. */
function FileView(props: { file: number; review: Review; view: View; cmd: Commands }) {
  const f = () => props.review.snapshot().files[props.file];
  const side = (): "old" | "new" => (f()?.new ? "new" : "old");
  const context = () => props.review.isContext(props.file);
  /** Threads on the side shown, by the row they end on. */
  const threadsByRow = createMemo(() => {
    const file = f();
    const model = props.review.models()[props.file];
    const byRow = new Map<number, Thread[]>();
    if (!file || !model) return byRow;
    for (const t of props.review.threads()) {
      if (t.anchor.path !== file.path || t.anchor.side !== side()) continue;
      const row = rowOf(model, t.anchor.side, t.anchor.end);
      if (row >= 0) byRow.set(row, [...(byRow.get(row) ?? []), t]);
    }
    return byRow;
  });
  /** The file's rows as runs of HTML, split where threads go. */
  const blocks = createMemo(() => {
    const file = f();
    const text = file ? (side() === "new" ? file.new : file.old) : null;
    if (!file || !text) return [];
    const marks = context() ? [] : changeMarks(file, side());
    const refs = props.review.definedNames();
    const out: { html: string; after: Thread[] }[] = [];
    let html = "";
    file.rows.forEach((row, r) => {
      const line = side() === "new" ? row[1] : row[0];
      if (line === null) return;
      html += fileViewRowHtml(props.file, r, side(), line, text, marks[line] ?? "", refs);
      const threads = threadsByRow().get(r);
      if (threads) {
        out.push({ html, after: threads });
        html = "";
      }
    });
    out.push({ html, after: [] });
    return out;
  });
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
        <div class="rows">
          <For each={blocks()}>
            {(b) => (
              <>
                <div innerHTML={b.html} />
                <Show when={b.after.length > 0}>
                  <div class="border-y border-line bg-inset py-1.5 pl-[51px]">
                    <For each={b.after}>
                      {(t) => (
                        <div class="mr-2.5">
                          <ThreadCard thread={t} review={props.review} cmd={props.cmd} />
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </>
            )}
          </For>
        </div>
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
