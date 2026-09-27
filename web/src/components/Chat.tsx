import { createEffect, For, Show } from "solid-js";
import type { Review } from "../state/review";
import type { View } from "../state/view";
import { Markdown } from "./Markdown";
import { AGENT } from "./ThreadCard";

/** A simple place to ask the agent anything that isn't about specific lines. */
export function Chat(props: { review: Review; view: View }) {
  let log: HTMLDivElement | undefined;
  let input: HTMLInputElement | undefined;
  createEffect(() => {
    props.review.conv.chat.length;
    queueMicrotask(() => log?.scrollTo({ top: log.scrollHeight }));
  });
  const send = (e: SubmitEvent) => {
    e.preventDefault();
    const text = input?.value.trim();
    if (!text || !input) return;
    props.review.chat(text);
    input.value = "";
  };
  return (
    <section aria-label={`Chat with ${AGENT}`} class="flex-none border-t border-line bg-panel">
      <Show when={props.review.conv.chat.length > 0}>
        <div ref={log} class="flex max-h-[190px] flex-col gap-1.5 overflow-auto px-3 pt-1.5">
          <For each={props.review.conv.chat}>
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
                <Markdown text={m.body} paths={props.review.paths()} class="max-w-[90ch] pt-px" />
              </div>
            )}
          </For>
        </div>
      </Show>
      <form class="flex items-center gap-2 px-2.5 py-1.5" onSubmit={send}>
        <input
          ref={input}
          id="chat-input"
          autocomplete="off"
          placeholder={`Ask ${AGENT} about this diff`}
          aria-label={`Message ${AGENT}`}
          class="h-7 min-w-0 flex-1 rounded-md border border-line-strong bg-bg px-2.5 text-[12.5px] focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.currentTarget.blur();
              document.getElementById("buffer")?.focus({ preventScroll: true });
            }
          }}
        />
        <span class="hidden text-[11px] whitespace-nowrap text-subtle sm:inline">
          <kbd>space</kbd> <kbd>i</kbd> to focus · <kbd>enter</kbd> to send
        </span>
      </form>
    </section>
  );
}
