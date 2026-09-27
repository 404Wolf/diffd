import { For, Show } from "solid-js";
import type { Commands } from "../state/commands";
import type { View } from "../state/view";

/**
 * The quickfix list, under the code: references and the like, to step through
 * with ]q / [q or by clicking, without a popup in the way.
 */
export function QuickfixList(props: { view: View; cmd: Commands }) {
  return (
    <Show when={props.view.quickfix()}>
      {(q) => (
        <section
          aria-label="Quickfix list"
          class="flex max-h-[30%] min-h-0 flex-none flex-col border-t border-line-strong bg-panel text-xs"
        >
          <header class="flex flex-none items-center gap-2 px-2.5 py-1 text-muted">
            <span class="font-semibold text-fg">{q().title}</span>
            <span class="text-subtle">
              <kbd>]q</kbd> <kbd>[q</kbd> next / previous
            </span>
            <button
              type="button"
              class="ml-auto cursor-pointer rounded px-1.5 text-subtle hover:bg-hover hover:text-fg"
              aria-label="Close the list"
              title="Close (space q)"
              onClick={() => props.view.setQuickfix(null)}
            >
              ×
            </button>
          </header>
          <ol class="min-h-0 overflow-auto pb-1">
            <For each={q().items}>
              {(item, i) => (
                <li>
                  <button
                    type="button"
                    class="flex w-full cursor-pointer items-baseline gap-3 px-2.5 py-0.5 text-left hover:bg-hover"
                    classList={{ "bg-accent-soft": q().index === i() }}
                    aria-current={q().index === i()}
                    data-quickfix={i()}
                    onClick={() => props.cmd.quickfixGo(i())}
                  >
                    <span class="w-40 flex-none truncate font-mono text-[11.5px] text-fg">{item.label}</span>
                    <span class="min-w-0 truncate font-mono text-[11px] text-muted">{item.detail}</span>
                  </button>
                </li>
              )}
            </For>
          </ol>
        </section>
      )}
    </Show>
  );
}
