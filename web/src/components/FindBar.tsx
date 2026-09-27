import { Show } from "solid-js";
import { MAX_MATCHES } from "../lib/search";
import type { Commands } from "../state/commands";
import type { View } from "../state/view";

/**
 * Ctrl+F: a small bar in the corner of the code that finds as you type, in
 * the cursor's file (or every file). Enter / Shift+Enter go to the next /
 * previous match; Esc closes it, and n / N keep going from the buffer.
 */
export function FindBar(props: { view: View; cmd: Commands }) {
  const count = () => {
    const s = props.view.search();
    if (!s || s.query === "") return "";
    if (s.matches.length === 0) return "No matches";
    const more = s.matches.length >= MAX_MATCHES ? "+" : "";
    return `${s.index < 0 ? "–" : s.index + 1}/${s.matches.length}${more}`;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // `/`: the match is where you are now, back to the code; n / N go on from it.
      if (props.view.find()?.vim) props.cmd.closeFind();
      else props.cmd.searchNext(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      props.cmd.closeFind();
    }
  };
  return (
    <Show when={props.view.find()}>
      {(find) => (
        <search
          class="absolute top-1.5 right-4 z-20 flex items-center gap-1 rounded-md border border-line-strong bg-bg py-0.5 pr-0.5 pl-2 text-xs shadow-pop"
          aria-label="Find"
        >
          <input
            id="find-input"
            type="text"
            placeholder={`${find().vim ? "/ " : ""}${find().scope === "file" ? "Find in this file" : "Find in every file"}`}
            aria-label="Find"
            autocomplete="off"
            spellcheck={false}
            value={props.view.search()?.query ?? ""}
            class="h-6 w-52 bg-transparent font-mono text-xs outline-none"
            onInput={(e) => props.cmd.findAsYouType(e.currentTarget.value)}
            onKeyDown={onKey}
          />
          <span class="min-w-[4.5ch] text-right font-mono text-[11px] text-subtle" data-find-count>
            {count()}
          </span>
          <button
            type="button"
            class="cursor-pointer rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-hover hover:text-fg"
            classList={{ "bg-accent-soft text-accent": find().scope === "all" }}
            aria-pressed={find().scope === "all"}
            title={find().scope === "file" ? "Search every file instead" : "Search only this file"}
            onClick={() => props.cmd.setFindScope(find().scope === "file" ? "all" : "file")}
          >
            All files
          </button>
          <button
            type="button"
            class="cursor-pointer rounded px-1 text-subtle hover:bg-hover hover:text-fg"
            aria-label="Previous match"
            title="Previous match (shift+enter)"
            onClick={() => props.cmd.searchNext(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            class="cursor-pointer rounded px-1 text-subtle hover:bg-hover hover:text-fg"
            aria-label="Next match"
            title="Next match (enter)"
            onClick={() => props.cmd.searchNext(1)}
          >
            ↓
          </button>
          <button
            type="button"
            class="cursor-pointer rounded px-1 text-subtle hover:bg-hover hover:text-fg"
            aria-label="Close"
            title="Close (esc)"
            onClick={() => props.cmd.closeFind()}
          >
            ×
          </button>
        </search>
      )}
    </Show>
  );
}
