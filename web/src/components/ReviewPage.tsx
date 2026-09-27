import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { match } from "ts-pattern";
import type { ReviewState } from "../gen/ReviewState";
import { spanLabel } from "../lib/history";
import { KeyEngine, keyToken, type Mode } from "../lib/keymap";
import { fillAll } from "../lib/lazyRows";
import { BINDINGS, type Ctx } from "../state/bindings";
import { createCommands } from "../state/commands";
import {
  bufferEl,
  keepViewport,
  navigableRows,
  readingPosition,
  restoreReadingPosition,
  rowEl,
} from "../state/dom";
import { createReview } from "../state/review";
import { createView, type View } from "../state/view";
import { Buffer } from "./Buffer";
import { Chat } from "./Chat";
import { Help, Nudge, Picker, StatusLine, TopBar } from "./Chrome";
import { CommentPopover, SelectionBubble } from "./CommentPopover";
import { Drawer } from "./Drawer";
import { FileTree } from "./FileTree";
import { RightPanel } from "./RightPanel";

/** Wait this long for the rest of a key sequence (`g` → `g d`). */
const SEQUENCE_TIMEOUT_MS = 1000;

export function ReviewPage(props: { state: ReviewState }) {
  let view: View | undefined;
  const review = createReview(props.state, {
    layout: keepViewport,
    onRevision: (_, next) => view?.say(`Revision ${next.revision} arrived`),
    onShow: (request) => view?.setNudge(request),
    onSpan: () => requestAnimationFrame(() => showSpanStart()),
  });
  const v = createView(review);
  view = v;
  const cmd = createCommands(review, v);
  /** A different part of the history is on screen: start at its first change. */
  const showSpanStart = () => {
    v.setMode({ kind: "diff" });
    v.setVisual(null);
    v.setSelection(null);
    bufferEl()?.scrollTo({ top: 0 });
    const first = navigableRows().find((r) => r.dataset.chg === "1") ?? navigableRows()[0];
    if (first) cmd.place(first, { scroll: "center" });
    v.say(spanLabel(review.history(), review.span()));
    trackScroll();
  };
  const ctx: Ctx = { cmd, view: v };
  const engine = new KeyEngine<Ctx>(BINDINGS);
  let container: HTMLDivElement | undefined;

  const [focusInput, setFocusInput] = createSignal(false);
  const mode = (): Mode => {
    if (v.visual()) return "visual";
    if (v.cursor()?.word) return "symbol";
    return v.mode().kind === "file" ? "file" : "normal";
  };
  const modeLabel = () => (focusInput() ? "INSERT" : mode().toUpperCase());

  // Which file is at the top of the buffer, for the tree's highlight.
  const [currentFile, setCurrentFile] = createSignal<number | null>(null);
  const trackScroll = () => {
    const buf = bufferEl();
    if (!buf) return;
    const m = v.mode();
    if (m.kind === "file") return setCurrentFile(m.file);
    const top = buf.getBoundingClientRect().top + 40;
    let current: number | null = null;
    for (const s of buf.querySelectorAll<HTMLElement>("[data-file-section]")) {
      if (s.getBoundingClientRect().top <= top) current = Number(s.dataset.fileSection);
      else break;
    }
    setCurrentFile(current ?? (review.snapshot().files.length ? 0 : null));
    rememberReading();
  };

  // -- Picking up where you left off ------------------------------------------------
  const rememberReading = () => {
    const pos = review.span() === null && v.mode().kind === "diff" ? readingPosition() : null;
    const path = pos ? review.snapshot().files[pos.file]?.path : undefined;
    if (!pos || path === undefined) return;
    v.persist.update((s) => {
      s.reading = { path, row: pos.row, offset: pos.offset, side: "new" };
    });
  };
  createEffect(() => {
    const c = v.cursor();
    const path = c ? review.snapshot().files[c.file]?.path : undefined;
    if (!c || path === undefined || review.span() !== null) return;
    v.persist.update((s) => {
      s.cursor = { path, row: c.row, offset: 0, side: c.side };
    });
  });
  /** Put the cursor and the page back where they were before the reload. Returns whether it could. */
  const restorePlace = (): boolean => {
    const { cursor, reading, draft } = v.persist.session;
    const find = (path: string, row: number) => {
      const file = review.paths().indexOf(path);
      if (file < 0) return null;
      if (!rowEl(file, row)) fillAll();
      return rowEl(file, row) ? file : null;
    };
    const readAt = reading ? find(reading.path, reading.row) : null;
    const cursorAt = cursor ? find(cursor.path, cursor.row) : null;
    if (reading && readAt !== null)
      restoreReadingPosition({ file: readAt, row: reading.row, offset: reading.offset });
    if (cursor && cursorAt !== null) {
      const el = rowEl(cursorAt, cursor.row);
      if (el) cmd.place(el, { side: cursor.side, scroll: readAt === null ? "center" : false });
    }
    if (draft) v.setComposer(draft.composer);
    return readAt !== null || cursorAt !== null;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Control" || e.key === "Meta") v.setSymKey(true);
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable]") || v.picker() || v.help()) return;
    if (v.nudge() && (e.key === "Enter" || e.key === "Escape")) {
      e.preventDefault();
      return cmd.nudgeDone(e.key === "Enter");
    }
    const token = keyToken(e);
    if (!token) return;
    clearTimeout(timer);
    if (engine.display() === "g" && token === "c" && v.selection()) {
      e.preventDefault();
      engine.reset();
      v.setPending("");
      cmd.commentSelection();
      return;
    }
    const result = engine.feed(token, mode(), ctx);
    match(result)
      .with({ kind: "ran" }, () => {
        e.preventDefault();
        v.setPending("");
      })
      .with({ kind: "pending" }, ({ display }) => {
        e.preventDefault();
        v.setPending(display);
        timer = setTimeout(() => {
          engine.flush(mode(), ctx);
          v.setPending("");
        }, SEQUENCE_TIMEOUT_MS);
      })
      .with({ kind: "unbound" }, () => v.setPending(""))
      .exhaustive();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === "Control" || e.key === "Meta") v.setSymKey(false);
  };
  const onFocus = () => setFocusInput(document.activeElement?.matches("input, textarea") ?? false);

  onMount(() => {
    review.start();
    // Layout can change without scrolling (threads arriving): take the reading position fresh on the way out.
    const leaving = () => {
      rememberReading();
      v.persist.flush();
    };
    window.addEventListener("pagehide", leaving);
    document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && leaving());
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", () => v.setSymKey(false));
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", () => queueMicrotask(onFocus));
    const buf = bufferEl();
    // Scroll events don't bubble, but they can be captured: one listener for every split.
    container?.addEventListener("scroll", () => requestAnimationFrame(trackScroll), {
      passive: true,
      capture: true,
    });
    if (!restorePlace()) {
      const first = navigableRows().find((r) => r.dataset.chg === "1") ?? navigableRows()[0];
      if (first) cmd.place(first, { scroll: false });
    }
    trackScroll();
    buf?.focus({ preventScroll: true });
    document.title = `${review.meta().title} · diffd`;
  });
  onCleanup(() => {
    review.stop();
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    document.removeEventListener("focusin", onFocus);
  });

  return (
    <div class="flex h-full flex-col bg-bg">
      <TopBar review={review} />
      <div ref={container} class="relative flex min-h-0 flex-1">
        <Drawer side="left" label="Files" state={v.drawers.left} onChange={(s) => v.setDrawers("left", s)}>
          <FileTree review={review} view={v} cmd={cmd} current={currentFile} />
        </Drawer>
        <div class="flex min-w-0 flex-1 flex-col">
          <div class="flex min-h-0 flex-1">
            <For each={v.panes()}>
              {(pane, i) => (
                <>
                  <Show when={i() > 0}>
                    <div class="w-px flex-none bg-line-strong" />
                  </Show>
                  <Buffer review={review} view={v} cmd={cmd} pane={pane} />
                </>
              )}
            </For>
          </div>
          <Chat review={review} view={v} />
        </div>
        <Drawer
          side="right"
          label="Activity and commits"
          state={v.drawers.right}
          onChange={(s) => v.setDrawers("right", s)}
          badge={review.unread().length > 0}
        >
          <RightPanel review={review} view={v} cmd={cmd} />
        </Drawer>
        <Nudge view={v} cmd={cmd} />
        <SelectionBubble cmd={cmd} view={v} container={() => container} />
        <CommentPopover review={review} view={v} cmd={cmd} container={() => container} />
      </div>
      <StatusLine review={review} view={v} mode={modeLabel} />
      <Picker view={v} />
      <Help view={v} />
      <Show when={review.error()}>
        {(message) => (
          <div class="fixed right-4 bottom-10 z-40 flex max-w-sm items-start gap-2 rounded-lg border border-del bg-bg px-3 py-2 text-xs shadow-pop">
            <span class="text-del">{message()}</span>
            <button
              type="button"
              class="cursor-pointer text-muted hover:text-fg"
              onClick={() => review.clearError()}
            >
              Dismiss
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}
