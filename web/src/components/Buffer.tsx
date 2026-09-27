import { createEffect, createMemo, Index, Show } from "solid-js";
import { changeMarks, fileViewRowHtml, lineHtml } from "../lib/render";
import type { Commands } from "../state/commands";
import { bufferEl, rowEl } from "../state/dom";
import type { Review } from "../state/review";
import type { Pane, View } from "../state/view";
import { FileSection } from "./FileSection";
import { Markdown } from "./Markdown";

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

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const link = target.closest<HTMLElement>("[data-go]");
    if (link?.dataset.go) {
      const [file, line] = link.dataset.go.split(":").map(Number);
      if (file !== undefined && line !== undefined) props.cmd.goTo(file, "new", line);
      return;
    }
    const row = target.closest<HTMLElement>(".row");
    if (!row) return;
    const num = target.closest<HTMLElement>(".num[data-n]");
    const code = target.closest<HTMLElement>(".code[data-side]");
    const side = (num?.dataset.side ?? code?.dataset.side) as "old" | "new" | undefined;
    if (!side) return;
    const selection = getSelection();
    if (selection && !selection.isCollapsed) return;
    if (num && props.pane.mode().kind === "diff") {
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
    if (word && (e.ctrlKey || e.metaKey)) props.cmd.gotoDefinition(word.text);
  };

  return (
    // Clicks are delegated from static rows; every click action also has a key binding.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard equivalents live in state/bindings.ts
    <main
      id={`buffer-${props.pane.id}`}
      data-pane={props.pane.id}
      tabindex="-1"
      class="buffer min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain bg-inset pb-6 outline-none [overflow-anchor:none]"
      classList={{ sym: props.view.symKey(), focused: props.view.focused().id === props.pane.id }}
      onPointerDown={() => props.view.focusPane(props.pane.id)}
      onFocusIn={() => props.view.focusPane(props.pane.id)}
      onClick={onClick}
    >
      <Show
        when={props.pane.mode().kind === "file" ? (props.pane.mode() as { file: number }).file : null}
        fallback={
          <>
            <Summary review={props.review} cmd={props.cmd} />
            {/* Index, not For: sections stay put across revisions and only their contents update. */}
            <Index each={props.review.snapshot().files}>
              {(_, i) => <FileSection index={i} review={props.review} view={props.view} cmd={props.cmd} />}
            </Index>
            <Show when={props.review.snapshot().files.length === 0}>
              <p class="p-6 text-center text-muted">No changes between these revisions.</p>
            </Show>
          </>
        }
      >
        {(file) => <FileView file={file()} review={props.review} />}
      </Show>
    </main>
  );
}

function Summary(props: { review: Review; cmd: Commands }) {
  return (
    <Show when={props.review.meta().summary || props.review.notes().length > 0}>
      <div class="mx-2.5 mt-2.5 mb-0.5 rounded-md border border-accent-line bg-bg px-3 py-2 text-[12.5px]">
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

/** `g enter`: the plain file, with slight marks where it changed. */
function FileView(props: { file: number; review: Review }) {
  const f = () => props.review.snapshot().files[props.file];
  const html = createMemo(() => {
    const file = f();
    if (!file) return "";
    const side = file.new ? "new" : "old";
    const text = file.new ?? file.old;
    if (!text) return "";
    const marks = changeMarks(file, side);
    const refs = props.review.definedNames();
    let out = "";
    file.rows.forEach((row, r) => {
      const line = side === "new" ? row[1] : row[0];
      if (line !== null) out += fileViewRowHtml(props.file, r, side, line, text, marks[line] ?? "", refs);
    });
    return out;
  });
  return (
    <>
      <div class="mx-2.5 mt-2.5 flex flex-wrap items-center gap-2 rounded-md border border-line-strong bg-bg px-2.5 py-1.5 text-xs text-muted">
        <b class="font-mono font-semibold text-fg">{f()?.path}</b>
        <span>the file at revision {props.review.meta().revision}, no diff</span>
        <span class="flex-1" />
        <Legend color="var(--add-mark)" label="added" />
        <Legend color="var(--mod-mark)" label="changed" />
        <Legend color="var(--del-mark)" label="removed" />
        <span>
          <kbd>ctrl</kbd> <kbd>o</kbd> back to the diff
        </span>
      </div>
      <section class="fv mx-2.5 my-2 overflow-clip rounded-md border border-line-strong bg-bg">
        <div class="rows" innerHTML={html()} />
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
  createEffect(() => {
    const cursor = props.pane.cursor();
    const visual = props.pane.visual();
    // Re-paint after anything that re-renders rows.
    props.pane.mode();
    props.review.snapshot();
    props.review.threads().length;
    for (let i = 0; i < props.review.snapshot().files.length; i++) props.view.visible(i);
    queueMicrotask(() => {
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
    });
  });
}
