import { createEffect, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { match } from "ts-pattern";
import type { ReviewState, Side } from "../api";
import { carryRow } from "../lib/diffModel";
import { rangeOf, spanLabel, spanOf } from "../lib/history";
import { composing, KeyEngine, keyToken, type Mode } from "../lib/keymap";
import { BINDINGS, type Ctx } from "../state/bindings";
import { createCommands } from "../state/commands";
import { bufferEl, readingPosition, restoreReadingPosition } from "../state/dom";
import { createLayout } from "../state/layout";
import type { SavedPane, SavedPlace } from "../state/persist";
import { createReview } from "../state/review";
import { createView, type Pane, type View } from "../state/view";
import { Buffer } from "./Buffer";
import { Help, Nudge, Picker, StatusLine, TopBar } from "./Chrome";
import { CommentPopover, SelectionBubble } from "./CommentPopover";
import { Drawer } from "./Drawer";
import { FileTree } from "./FileTree";
import { FindBar } from "./FindBar";
import { HoverCard, usePaintDiagnostics } from "./Hover";
import { QuickfixList } from "./Quickfix";
import { RightPanel } from "./RightPanel";
import { usePaintSearch } from "./SearchHighlights";
import { ReplyToasts } from "./Toasts";

/** Wait this long for the rest of a key sequence (`g` → `g d`). */
const SEQUENCE_TIMEOUT_MS = 1000;

export function ReviewPage(props: { state: ReviewState }) {
  let view: View | undefined;
  /**
   * Keep each pane on the same line of code through a change from the agent.
   * The window keeps its top item in place by itself, but a revision renumbers
   * rows (lines added above) and files (a file added before): follow the code.
   */
  const keepPlace = (update: () => void) => {
    const prev = review.snapshot();
    const places = view ? view.panes().map((p) => [p.id, readingPosition(bufferEl(p.id))] as const) : [];
    update();
    const next = review.snapshot();
    if (next === prev) return;
    const byPath = new Map(next.files.map((f, i) => [f.path, i]));
    for (const [pane, at] of places) {
      const from = at ? prev.files[at.file] : undefined;
      const file = from ? byPath.get(from.path) : undefined;
      const to = file === undefined ? undefined : review.models()[file];
      if (at && from && file !== undefined && to)
        restoreReadingPosition({ file, row: carryRow(from, to, at.row), offset: at.offset }, bufferEl(pane));
    }
  };
  const review = createReview(props.state, {
    layout: keepPlace,
    onRevision: (_, next) => view?.say(`Revision ${next.revision} arrived`),
    onShow: (request) => view?.setNudge(request),
    onSpan: () => {
      if (!restoring) requestAnimationFrame(() => showSpanStart());
    },
  });
  const v = createView(review);
  view = v;
  const layout = createLayout(review, v);
  const cmd = createCommands(review, v);
  usePaintDiagnostics({ review, view: v });
  usePaintSearch({ view: v });
  /** A different part of the history is on screen: start at its first change. */
  const showSpanStart = () => {
    v.setMode({ kind: "diff" });
    v.setVisual(null);
    v.setSelection(null);
    bufferEl()?.scrollTo({ top: 0 });
    cmd.startAtFirstChange("center");
    v.say(spanLabel(review.history(), review.span()));
    trackScroll();
  };
  const ctx: Ctx = { cmd, view: v };
  const engine = new KeyEngine<Ctx>(BINDINGS);
  let container: HTMLDivElement | undefined;
  let root: HTMLDivElement | undefined;

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
    const m = v.mode();
    if (m.kind === "file") return setCurrentFile(m.file);
    setCurrentFile(readingPosition()?.file ?? null);
    saveSession();
  };

  // -- Picking up where you left off ------------------------------------------------
  /** A reload's restoring: the commits it brings back shouldn't move the cursor to their start. */
  let restoring = false;
  /** The last session has been put back: from now on, what's on screen is saved. */
  let settled = false;
  /** Remember every split (what it shows, where it's read, its cursor), the focused one, and the commits shown. */
  const saveSession = () => {
    // Until the last session is put back, what's on screen isn't where you were.
    if (!settled) return;
    const files = review.snapshot().files;
    const place = (file: number, row: number, offset: number, side: Side): SavedPlace | null => {
      const path = files[file]?.path;
      return path === undefined ? null : { path, row, offset, side };
    };
    const panes = v.panes().map((p): SavedPane => {
      const m = p.mode();
      const c = p.cursor();
      const pos = readingPosition(bufferEl(p.id));
      return {
        file: m.kind === "file" ? (files[m.file]?.path ?? null) : null,
        reading: pos ? place(pos.file, pos.row, pos.offset, "new") : null,
        cursor: c ? place(c.file, c.row, 0, c.side) : null,
      };
    });
    const focused = Math.max(0, v.panes().indexOf(v.focused()));
    const range = rangeOf(review.history(), review.span());
    v.persist.update((s) => {
      s.panes = panes;
      s.focused = focused;
      s.range = range;
    });
  };
  createEffect(() => {
    // Anything that moves a split: its cursor, what it shows; splits opening and closing.
    for (const p of v.panes()) {
      p.cursor();
      p.mode();
    }
    v.focused();
    review.span();
    untrack(saveSession);
  });
  /** Put a split back: its reading position, then its cursor. Returns whether anything was. */
  const restorePane = (pane: Pane, saved: SavedPane): boolean => {
    const find = (place: SavedPlace | null) => {
      if (!place) return null;
      const file = review.paths().indexOf(place.path);
      return file >= 0 && place.row < (review.snapshot().files[file]?.rows.length ?? 0) ? file : null;
    };
    const readAt = find(saved.reading);
    const cursorAt = find(saved.cursor);
    if (saved.reading && readAt !== null)
      restoreReadingPosition(
        { file: readAt, row: saved.reading.row, offset: saved.reading.offset },
        bufferEl(pane.id),
      );
    if (saved.cursor && cursorAt !== null)
      cmd.placeRow(cursorAt, saved.cursor.row, {
        side: saved.cursor.side,
        scroll: readAt === null ? "center" : false,
      });
    return readAt !== null || cursorAt !== null;
  };
  /** Put the page back as it was before the reload: commits, splits, places, a comment being written. */
  const restoreSession = async (): Promise<boolean> => {
    const { panes, focused, range, draft } = v.persist.session;
    const span = range ? spanOf(review.history(), range) : null;
    if (span) {
      restoring = true;
      await review.showSpan(span);
      restoring = false;
    }
    let restored = false;
    for (const [i, saved] of panes.entries()) {
      if (i > 0) v.split();
      const pane = v.focused();
      const file = saved.file === null ? null : await review.openContext(saved.file);
      if (file !== null) pane.setMode({ kind: "file", file });
      // A new split or view is drawn in the next frame.
      if (i > 0 || file !== null) await new Promise(requestAnimationFrame);
      restored = restorePane(pane, saved) || restored;
    }
    const target = v.panes()[focused];
    if (target) v.focusPane(target.id);
    if (draft) v.setComposer(draft.composer);
    return restored;
  };

  /** `path:line` links in any Markdown (threads, chat, hover cards, notes) jump to the code. */
  const followLink = (e: MouseEvent) => {
    const link = (e.target as HTMLElement).closest<HTMLElement>("[data-go]");
    const go = link?.dataset.go;
    if (!go) return;
    e.preventDefault();
    const at = go.lastIndexOf(":");
    const [path, line] = [go.slice(0, at), Number(go.slice(at + 1))];
    // Shift+click: in a split, next to what you're reading.
    void (e.shiftKey ? cmd.openPathInSplit(path, line) : cmd.openPathAt(path, line));
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const onKeyDown = (e: KeyboardEvent) => {
    if (composing(e)) return;
    if (e.key === "Control" || e.key === "Meta") v.setSymKey(true);
    // Ctrl+F is always ours, even from a text box: the browser's find can't see rows off screen.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      return cmd.openFind();
    }
    const target = e.target as HTMLElement;
    const drawer = target.closest<HTMLElement>("aside[data-drawer]");
    // Ctrl+H / Ctrl+L move across the page from anywhere, text boxes included.
    if (
      e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      (e.key === "h" || e.key === "l") &&
      !v.picker() &&
      !v.help()
    ) {
      e.preventDefault();
      return cmd.focusAcross(
        e.key === "h" ? -1 : 1,
        (drawer?.dataset.drawer as "left" | "right" | undefined) ?? "panes",
      );
    }
    if (target.closest("input, textarea, select, [contenteditable], [role=menu]") || v.picker() || v.help())
      return;
    // In a drawer: j / k move through its items, esc goes back to the code.
    if (drawer && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const dir = e.key === "j" || e.key === "ArrowDown" ? 1 : e.key === "k" || e.key === "ArrowUp" ? -1 : 0;
      if (dir !== 0) {
        e.preventDefault();
        return cmd.moveInDrawer(drawer, dir);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        return bufferEl()?.focus({ preventScroll: true });
      }
      // Enter and space press the focused item; every other key works as it does in the code.
      if (e.key === "Enter" || e.key === " ") return;
    }
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
    // Every listener goes when the page does.
    const listening = new AbortController();
    const { signal } = listening;
    onCleanup(() => listening.abort());
    root?.addEventListener("click", followLink, { signal });
    review.start();
    onCleanup(() => review.stop());
    // Layout can change without scrolling (threads arriving): take the reading position fresh on the way out.
    const leaving = () => {
      saveSession();
      v.persist.flush();
    };
    window.addEventListener("pagehide", leaving, { signal });
    document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && leaving(), {
      signal,
    });
    window.addEventListener("keydown", onKeyDown, { signal });
    window.addEventListener("keyup", onKeyUp, { signal });
    window.addEventListener("blur", () => v.setSymKey(false), { signal });
    document.addEventListener("focusin", onFocus, { signal });
    document.addEventListener("focusout", () => queueMicrotask(onFocus), { signal });
    // Scroll events don't bubble, but they can be captured: one listener for every split.
    container?.addEventListener("scroll", () => requestAnimationFrame(trackScroll), {
      passive: true,
      capture: true,
      signal,
    });
    void restoreSession().then((restored) => {
      settled = true;
      if (!restored) cmd.startAtFirstChange(false);
      trackScroll();
      bufferEl()?.focus({ preventScroll: true });
    });
    document.title = `${review.meta().title} · diffd`;
  });

  return (
    <div ref={root} class="flex h-full flex-col bg-bg">
      <TopBar review={review} />
      <div ref={container} class="relative flex min-h-0 flex-1">
        <Drawer side="left" label="Files" state={v.drawers.left} onChange={(s) => v.setDrawers("left", s)}>
          <FileTree review={review} view={v} cmd={cmd} current={currentFile} />
        </Drawer>
        <div class="relative flex min-w-0 flex-1 flex-col">
          <ReplyToasts review={review} cmd={cmd} />
          <FindBar view={v} cmd={cmd} />
          <main id="panes" class="flex min-h-0 flex-1">
            <For each={v.panes()}>
              {(pane, i) => (
                <>
                  <Show when={i() > 0}>
                    <div class="w-px flex-none bg-line-strong" />
                  </Show>
                  <Buffer review={review} view={v} cmd={cmd} layout={layout} pane={pane} />
                </>
              )}
            </For>
          </main>
          <QuickfixList view={v} cmd={cmd} />
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
      <StatusLine review={review} view={v} layout={layout} mode={modeLabel} />
      <Picker view={v} />
      <HoverCard review={review} view={v} />
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
