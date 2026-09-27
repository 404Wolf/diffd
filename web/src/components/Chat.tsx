import { createEffect, For, Show } from "solid-js";
import { composing } from "../lib/keymap";
import { bufferEl } from "../state/dom";
import type { Review } from "../state/review";
import type { View } from "../state/view";
import { Markdown } from "./Markdown";
import { AGENT } from "./ThreadCard";

/** A simple place to ask the agent anything that isn't about specific lines. */
export function Chat(props: { review: Review; view: View }) {
  let log: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;
  createEffect(() => {
    props.review.chat().length;
    queueMicrotask(() => log?.scrollTo({ top: log.scrollHeight }));
  });
  const send = (e: SubmitEvent) => {
    e.preventDefault();
    const text = input?.value.trim();
    if (!text || !input) return;
    props.review.say(text);
    input.value = "";
  };
  return (
    // A fixed share of the side panel, whatever the conversation's length.
    <section
      aria-label={`Chat with ${AGENT}`}
      class="flex h-[30%] min-h-28 flex-none flex-col border-t border-line bg-panel"
    >
      <div ref={log} class="flex min-h-0 flex-1 flex-col gap-1.5 overflow-auto px-3 pt-1.5">
        <Show
          when={props.review.chat().length > 0}
          fallback={
            <p class="m-auto px-2 text-center text-[12px] text-subtle">
              Anything not about particular lines: ask {AGENT} here.
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
        <input
          ref={input}
          id="chat-input"
          autocomplete="off"
          placeholder={`Ask ${AGENT} about this diff`}
          aria-label={`Message ${AGENT}`}
          class="h-6 w-full min-w-0 rounded-md border border-line-strong bg-bg px-2.5 text-[12.5px] focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:outline-none"
          onKeyDown={(e) => {
            if (composing(e)) return;
            if (e.key === "Escape") {
              e.currentTarget.blur();
              bufferEl()?.focus({ preventScroll: true });
            }
          }}
        />
        <span class="text-[10.5px] whitespace-nowrap text-subtle">
          <kbd>space</kbd> <kbd>i</kbd> to focus · <kbd>enter</kbd> to send
        </span>
      </form>
    </section>
  );
}
