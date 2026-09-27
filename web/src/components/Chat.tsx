import { createEffect, createSignal, For, Show } from "solid-js";
import { agentName } from "../lib/agent";
import { composing } from "../lib/keymap";
import { bufferEl } from "../state/dom";
import type { Review } from "../state/review";
import type { View } from "../state/view";
import { Markdown } from "./Markdown";

/** A simple place to ask the agent anything that isn't about specific lines. */
/** The message box grows to this, then scrolls. */
const MAX_INPUT_PX = 120;

/** The chat's share of the side panel: 30% to start, between these when dragged. */
const SHARE_KEY = "diffd:chat-share";
const MIN_SHARE = 0.12;
const MAX_SHARE = 0.85;
function loadShare(): number {
  try {
    const saved = Number(localStorage.getItem(SHARE_KEY));
    return saved >= MIN_SHARE && saved <= MAX_SHARE ? saved : 0.3;
  } catch {
    return 0.3;
  }
}

export function Chat(props: { review: Review; view: View }) {
  let log: HTMLDivElement | undefined;
  let input: HTMLTextAreaElement | undefined;
  let box: HTMLElement | undefined;
  /** How much of the side panel the chat takes, remembered across reloads. */
  const [share, setShare] = createSignal(loadShare());
  const resizeTo = (next: number) => {
    setShare(Math.min(MAX_SHARE, Math.max(MIN_SHARE, next)));
    try {
      localStorage.setItem(SHARE_KEY, String(share()));
    } catch {
      // Not remembered, then.
    }
  };
  const startResize = (e: PointerEvent) => {
    const panel = box?.parentElement;
    if (!panel) return;
    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    const move = (m: PointerEvent) => resizeTo((rect.bottom - m.clientY) / rect.height);
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  /** As tall as what's typed, up to a few lines; then it scrolls. */
  const grow = () => {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_PX)}px`;
  };
  createEffect(() => {
    props.review.chat().length;
    queueMicrotask(() => log?.scrollTo({ top: log.scrollHeight }));
  });
  const send = (e?: SubmitEvent) => {
    e?.preventDefault();
    const text = input?.value.trim();
    if (!text || !input) return;
    props.review.say(text);
    input.value = "";
    grow();
  };
  return (
    // A share of the side panel (30% to start; drag its top edge), whatever the conversation's length.
    <section
      ref={box}
      aria-label={`Chat with ${agentName()}`}
      class="relative flex min-h-28 flex-none flex-col border-t border-line bg-panel"
      style={{ height: `${share() * 100}%` }}
    >
      {/* A focusable window splitter (WAI-ARIA): drag it, or arrows up and down. <hr> can't be dragged. */}
      {/* biome-ignore lint/a11y/useSemanticElements: see above */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the chat"
        aria-valuemin={MIN_SHARE * 100}
        aria-valuemax={MAX_SHARE * 100}
        aria-valuenow={Math.round(share() * 100)}
        tabindex="0"
        class="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize hover:bg-accent-soft focus:bg-accent-soft focus:outline-none"
        onPointerDown={startResize}
        onKeyDown={(e) => {
          const step = e.key === "ArrowUp" ? 0.05 : e.key === "ArrowDown" ? -0.05 : 0;
          if (step === 0) return;
          e.preventDefault();
          // Not the diff's cursor too.
          e.stopPropagation();
          resizeTo(share() + step);
        }}
      />
      <div ref={log} class="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto px-3 pt-1.5">
        <Show
          when={props.review.chat().length > 0}
          fallback={
            <p class="m-auto px-2 text-center text-[12px] text-subtle">
              Anything not about particular lines: ask {agentName()} here.
            </p>
          }
        >
          <For each={props.review.chat()}>
            {(m) => (
              <div class="grid grid-cols-[20px_minmax(0,1fr)] gap-2 text-[12.5px]">
                <div
                  class="grid size-5 place-items-center rounded-full text-[10px] font-semibold"
                  classList={{
                    "bg-accent-soft text-accent": m.author === "agent",
                    "bg-inset text-muted": m.author === "user",
                  }}
                >
                  {m.author === "agent" ? "✦" : "Y"}
                </div>
                <div class="min-w-0" classList={{ "opacity-75": props.review.isPending(m.id) }}>
                  <Markdown text={m.body} paths={props.review.paths()} class="max-w-[90ch] pt-px" />
                  <Show when={props.review.isPending(m.id)}>
                    <span data-pending class="text-[10.5px] font-medium text-warn">
                      {props.review.connection() === "live" ? "Sending…" : "Queued offline"}
                    </span>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </Show>
      </div>
      <form class="flex flex-none flex-col gap-0.5 px-2 py-1.5" onSubmit={send}>
        <textarea
          ref={input}
          id="chat-input"
          rows={1}
          autocomplete="off"
          placeholder={`Ask ${agentName()} about this diff`}
          aria-label={`Message ${agentName()}`}
          class="w-full min-w-0 resize-none rounded-md border border-line-strong bg-bg px-2.5 py-[3px] text-[12.5px] leading-[18px] focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:outline-none"
          onInput={grow}
          onKeyDown={(e) => {
            if (composing(e)) return;
            // Enter sends; shift+enter is a new line.
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            } else if (e.key === "Escape") {
              e.currentTarget.blur();
              bufferEl()?.focus({ preventScroll: true });
            }
          }}
        />
        {/* Each hint stays whole; a narrow panel wraps between them. */}
        <span class="flex flex-wrap gap-x-2 text-[10.5px] text-subtle [&>span]:whitespace-nowrap">
          <span>
            <kbd>space</kbd> <kbd>i</kbd> focus
          </span>
          <span>
            <kbd>enter</kbd> send
          </span>
          <span>
            <kbd>shift</kbd> <kbd>enter</kbd> new line
          </span>
        </span>
      </form>
    </section>
  );
}
