import { createMemo, For, type JSX, Show } from "solid-js";
import type { Commit } from "../api";
import { type Span, step, steps } from "../lib/history";
import { ago } from "../lib/time";
import { bufferEl } from "../state/dom";
import type { Review } from "../state/review";

/**
 * The review's commits, to walk one at a time (`]r` / `[r`) or look at any
 * run of them: click a commit, shift-click another to take in everything between.
 */
export function Commits(props: { review: Review }) {
  const h = () => props.review.history();
  /** The span being shown, or the one on its way. */
  const current = () => props.review.loadingSpan() ?? props.review.span();
  const inSpan = (i: number) => {
    const s = current();
    return s !== null && i >= s.from && i < s.to;
  };
  /** Keys keep working after a click: they go to the diff, not the list. */
  const show = (span: Span) => {
    void props.review.showSpan(span);
    bufferEl()?.focus({ preventScroll: true });
  };
  const pick = (i: number, e: MouseEvent) => {
    const s = props.review.span();
    const next: Span =
      e.shiftKey && s !== null ? { from: Math.min(s.from, i), to: Math.max(s.to, i + 1) } : step(i);
    show(next);
  };
  const count = createMemo(() => steps(h()));

  return (
    <Show when={h().commits.length > 0}>
      <nav aria-label="Commits">
        <ul class="px-1.5 pt-1 pb-2">
          <Item
            selected={current() === null}
            loading={false}
            onClick={() => show(null)}
            title="Every change in the review"
          >
            <span class="truncate font-medium">All changes</span>
          </Item>
          <Show when={h().truncated}>
            <li class="px-1 py-0.5 text-[11px] text-subtle">Older commits not listed</li>
          </Show>
          <For each={h().commits}>
            {(c, i) => (
              <Item
                selected={inSpan(i())}
                loading={props.review.loadingSpan() !== undefined && inSpan(i())}
                onClick={(e) => pick(i(), e)}
                title={tooltip(c)}
              >
                <span class="flex min-w-0 flex-1 flex-col leading-tight">
                  <span class="truncate">{c.subject}</span>
                  <span class="truncate text-[10.5px] text-subtle">
                    <span class="font-mono">{c.short.slice(0, 7)}</span> · {c.author} · {ago(c.time)}
                  </span>
                </span>
              </Item>
            )}
          </For>
          <Show when={h().worktree}>
            <Item
              selected={inSpan(count() - 1)}
              loading={props.review.loadingSpan() !== undefined && inSpan(count() - 1)}
              onClick={(e) => pick(count() - 1, e)}
              title="Changes not committed yet"
            >
              <span class="truncate text-muted italic">Uncommitted changes</span>
              <span class="ml-auto size-1.5 flex-none rounded-full bg-warn" />
            </Item>
          </Show>
        </ul>
      </nav>
    </Show>
  );
}

function Item(props: {
  selected: boolean;
  loading: boolean;
  onClick: (e: MouseEvent) => void;
  title: string;
  children: JSX.Element;
}) {
  return (
    <li>
      <button
        type="button"
        class="relative flex min-h-5 w-full cursor-pointer items-center gap-1.5 rounded py-0.5 pr-1 pl-2 text-left text-[12.5px] whitespace-nowrap hover:bg-hover"
        classList={{ "bg-accent-soft": props.selected, "animate-pulse": props.loading }}
        aria-current={props.selected}
        title={props.title}
        onClick={(e) => props.onClick(e)}
      >
        <Show when={props.selected}>
          <i class="absolute top-1 bottom-1 left-0 w-0.5 rounded bg-accent" />
        </Show>
        {props.children}
      </button>
    </li>
  );
}

const tooltip = (c: Commit) =>
  `${c.subject}\n${c.short} · ${c.author} · ${new Date(c.time).toLocaleString()}\nShift-click to include every commit in between`;
