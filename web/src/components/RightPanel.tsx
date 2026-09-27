import { For, type JSX, Show } from "solid-js";
import type { Commands } from "../state/commands";
import type { Review } from "../state/review";
import type { RightTab, View } from "../state/view";
import { Activity } from "./Activity";
import { Commits } from "./Commits";

/** The right drawer: activity or commits in tabs, and your marks underneath. */
export function RightPanel(props: { review: Review; view: View; cmd: Commands }) {
  const hasCommits = () => props.review.history().commits.length > 0;
  const tab = (): RightTab => (props.view.rightTab() === "commits" && hasCommits() ? "commits" : "activity");
  return (
    <div class="flex h-full flex-col">
      <div
        role="tablist"
        aria-label="Activity and commits"
        class="flex flex-none items-center gap-0.5 border-b border-line px-1.5 pt-1"
        onKeyDown={(e) => {
          // Arrow keys move between tabs, as tablists do.
          if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && hasCommits()) {
            props.view.setRightTab(tab() === "activity" ? "commits" : "activity");
            document.getElementById(`tab-${tab()}`)?.focus();
          }
        }}
      >
        <Tab id="activity" current={tab()} view={props.view}>
          Activity
          <Show when={props.review.unread().length > 0}>
            <span class="min-w-4 rounded-full bg-accent px-1 text-center text-[10px] leading-4 text-accent-fg">
              {props.review.unread().length}
            </span>
          </Show>
        </Tab>
        <Show when={hasCommits()}>
          <Tab id="commits" current={tab()} view={props.view}>
            Commits <span class="text-subtle">{props.review.history().commits.length}</span>
          </Tab>
        </Show>
      </div>
      <div
        role="tabpanel"
        id="tabpanel-right"
        aria-labelledby={`tab-${tab()}`}
        class="min-h-0 flex-1 overflow-auto"
      >
        <Show when={tab() === "commits"} fallback={<Activity review={props.review} cmd={props.cmd} />}>
          <Commits review={props.review} />
        </Show>
      </div>
      <Marks view={props.view} cmd={props.cmd} />
    </div>
  );
}

function Tab(props: { id: RightTab; current: RightTab; view: View; children: JSX.Element }) {
  return (
    <button
      type="button"
      role="tab"
      id={`tab-${props.id}`}
      aria-controls="tabpanel-right"
      aria-selected={props.current === props.id}
      tabindex={props.current === props.id ? 0 : -1}
      class="-mb-px flex cursor-pointer items-center gap-1 border-b-2 px-2 pb-1 text-[11.5px] font-medium"
      classList={{
        "border-accent text-fg": props.current === props.id,
        "border-transparent text-muted hover:text-fg": props.current !== props.id,
      }}
      onClick={() => props.view.setRightTab(props.id)}
    >
      {props.children}
    </button>
  );
}

/** Lines you marked with `m{a-z}`; `'a` jumps back. */
function Marks(props: { view: View; cmd: Commands }) {
  const list = () => Object.entries(props.view.marks).sort(([a], [b]) => a.localeCompare(b));
  return (
    <section aria-label="Marks" class="max-h-[35%] flex-none overflow-auto border-t border-line">
      <div class="flex items-center gap-1.5 px-2.5 pt-1.5 pb-0.5 text-[10.5px] font-semibold tracking-wider text-muted uppercase">
        Marks
        <span class="ml-auto font-normal tracking-normal normal-case text-subtle">
          <kbd>m</kbd>a set · <kbd>'</kbd>a jump
        </span>
      </div>
      <Show
        when={list().length > 0}
        fallback={<p class="px-2.5 pb-2 text-[11.5px] text-subtle">No marks yet.</p>}
      >
        <ul class="px-1.5 pb-1.5">
          <For each={list()}>
            {([name, m]) => (
              <li class="group flex items-center">
                <button
                  type="button"
                  class="flex min-w-0 flex-1 cursor-pointer items-baseline gap-1.5 rounded px-1 py-0.5 text-left hover:bg-hover"
                  onClick={() => props.cmd.jumpToMark(name)}
                  title={`${m.path}:${m.line} (${m.side})`}
                >
                  <span class="w-3 flex-none font-mono text-[11px] font-semibold text-accent">{name}</span>
                  <span class="flex min-w-0 flex-col leading-tight">
                    <span class="truncate font-mono text-[11px]">
                      {m.path.split("/").pop()}:{m.line}
                    </span>
                    <span class="truncate font-mono text-[10.5px] text-subtle">{m.text}</span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`Delete mark ${name}`}
                  class="invisible cursor-pointer px-1 text-subtle group-hover:visible hover:text-fg"
                  onClick={() => props.cmd.deleteMark(name)}
                >
                  ×
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
