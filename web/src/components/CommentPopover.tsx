import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { match } from "ts-pattern";
import type { Commands } from "../state/commands";
import { bufferEl, rowEl } from "../state/dom";
import type { Review } from "../state/review";
import type { View } from "../state/view";
import { AGENT } from "./ThreadCard";

/**
 * The comment composer: a small popover right under what you selected. It
 * floats over the diff, so opening it, typing and sending never scroll.
 */
export function CommentPopover(props: {
  review: Review;
  view: View;
  cmd: Commands;
  container: () => HTMLElement | undefined;
}) {
  let el: HTMLDivElement | undefined;
  let input: HTMLTextAreaElement | undefined;
  const [pos, setPos] = createSignal({ top: 0, left: 0 });
  const [armed, setArmed] = createSignal(false);

  const anchor = (): HTMLElement | null => {
    const c = props.view.composer();
    if (!c) return null;
    return match(c)
      .with({ kind: "reply" }, ({ threadId }) =>
        document.querySelector<HTMLElement>(`#thread-${threadId} > div:last-child`),
      )
      .with({ kind: "new" }, ({ anchor: a }) => {
        const file = props.review.paths().indexOf(a.path);
        const model = props.review.models()[file];
        const map = a.side === "old" ? model?.oldRow : model?.newRow;
        const row = map?.[a.end - 1] ?? -1;
        return rowEl(file, row)?.querySelector<HTMLElement>(`.code[data-side="${a.side}"]`) ?? null;
      })
      .exhaustive();
  };

  const place = () => {
    const a = anchor();
    const box = props.container()?.getBoundingClientRect();
    const buf = bufferEl()?.getBoundingClientRect();
    if (!a || !box || !buf || !el) return;
    const r = a.getBoundingClientRect();
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    let top = r.bottom + 4;
    if (top + h > buf.bottom - 4) top = Math.max(buf.top + 4, r.top - h - 4);
    const left = Math.max(buf.left + 8, Math.min(buf.right - w - 8, r.left + 12));
    setPos({ top: top - box.top, left: left - box.left });
  };

  onMount(() => {
    const buf = bufferEl();
    buf?.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    onCleanup(() => {
      buf?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    });
  });
  createEffect(() => {
    if (props.view.composer()) {
      setArmed(false);
      queueMicrotask(() => {
        place();
        input?.focus({ preventScroll: true });
      });
    }
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      props.cmd.sendComposer(input?.value ?? "");
    } else if (e.key === "Escape") {
      e.preventDefault();
      if ((input?.value.trim() ?? "") !== "" && !armed()) {
        setArmed(true);
        props.view.say("Press esc again to discard this comment");
      } else props.cmd.closeComposer();
    }
  };

  return (
    <Show when={props.view.composer()}>
      {(c) => (
        <div
          ref={el}
          class="absolute z-20 w-[min(420px,calc(100%-20px))] rounded-lg border border-line-strong bg-bg p-2 text-xs shadow-pop"
          style={{ top: `${pos().top}px`, left: `${pos().left}px` }}
          role="dialog"
          aria-label="Write a comment"
        >
          {match(c())
            .with({ kind: "new" }, ({ anchor: a, quote }) => (
              <>
                <div class="mb-1.5 flex items-center gap-1.5 text-muted">
                  Comment on
                  <span class="font-mono text-[11px] text-fg">
                    {a.path.split("/").pop()} · {a.side}{" "}
                    {a.start === a.end ? `L${a.start}` : `L${a.start}–${a.end}`}
                  </span>
                </div>
                <pre class="mb-1.5 max-h-[58px] overflow-hidden rounded bg-inset px-1.5 py-1 font-mono text-[11px] leading-snug whitespace-pre-wrap text-muted">
                  {quote}
                </pre>
              </>
            ))
            .with({ kind: "reply" }, ({ label }) => (
              <div class="mb-1.5 flex items-center gap-1.5 text-muted">
                Reply on <span class="font-mono text-[11px] text-fg">{label}</span>
              </div>
            ))
            .exhaustive()}
          <textarea
            ref={input}
            aria-label="Comment"
            placeholder={`What should ${AGENT} know about this code?`}
            class="block min-h-16 w-full resize-y rounded-md border border-line-strong bg-bg px-2 py-1.5 text-[12.5px] leading-normal focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:outline-none"
            onKeyDown={onKey}
          />
          <div class="mt-1.5 flex items-center gap-1.5 text-[11px] text-subtle">
            <span>{AGENT} sees it once you pause</span>
            <span class="flex-1" />
            <button
              type="button"
              class="cursor-pointer rounded-md px-2 py-1 text-muted hover:bg-hover hover:text-fg"
              onClick={() => props.cmd.closeComposer()}
            >
              Cancel
            </button>
            <button
              type="button"
              class="inline-flex cursor-pointer items-center gap-1 rounded-md bg-accent px-2.5 py-1 font-medium text-accent-fg hover:brightness-110"
              onClick={() => props.cmd.sendComposer(input?.value ?? "")}
            >
              Comment <kbd>⌘</kbd>
              <kbd>↵</kbd>
            </button>
          </div>
        </div>
      )}
    </Show>
  );
}

/** A small "Comment" button by a mouse selection in the diff. */
export function SelectionBubble(props: {
  cmd: Commands;
  view: View;
  container: () => HTMLElement | undefined;
}) {
  const read = () => {
    const s = getSelection();
    if (
      !s ||
      s.isCollapsed ||
      s.rangeCount === 0 ||
      props.view.composer() ||
      props.view.mode().kind !== "diff"
    )
      return props.view.setSelection(null);
    const range = s.getRangeAt(0);
    const elOf = (n: Node) => (n instanceof HTMLElement ? n : n.parentElement);
    const a = elOf(range.startContainer)?.closest<HTMLElement>(".code[data-side]");
    const b = elOf(range.endContainer)?.closest<HTMLElement>(".code[data-side]");
    const ra = a?.closest<HTMLElement>(".row");
    const rb = b?.closest<HTMLElement>(".row");
    if (!a || !b || !ra || !rb || ra.dataset.f !== rb.dataset.f) return props.view.setSelection(null);
    const side = (b.dataset.side ?? "new") as "old" | "new";
    const key = side === "old" ? "ol" : "nl";
    const lines = [ra, rb].map((r) => Number(r.dataset[key])).filter((n) => n > 0);
    const box = props.container()?.getBoundingClientRect();
    if (lines.length === 0 || !box) return props.view.setSelection(null);
    const rect = range.getBoundingClientRect();
    props.view.setSelection({
      file: Number(ra.dataset.f),
      side,
      start: Math.min(...lines),
      end: Math.max(...lines),
      top: rect.bottom - box.top + 4,
      left: Math.min(box.width - 140, rect.right - box.left - 40),
    });
  };
  onMount(() => {
    const onChange = () => requestAnimationFrame(read);
    document.addEventListener("selectionchange", onChange);
    onCleanup(() => document.removeEventListener("selectionchange", onChange));
  });
  return (
    <Show when={props.view.selection()}>
      {(s) => (
        <button
          type="button"
          class="absolute z-20 inline-flex cursor-pointer items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg shadow-pop"
          style={{ top: `${s().top}px`, left: `${s().left}px` }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => props.cmd.commentSelection()}
        >
          Comment <kbd>gc</kbd>
        </button>
      )}
    </Show>
  );
}
