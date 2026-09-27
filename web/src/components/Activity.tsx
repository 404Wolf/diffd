import { For, Show } from "solid-js";
import { match } from "ts-pattern";
import type { ActivityItem } from "../gen/ActivityItem";
import { ago } from "../lib/time";
import type { Commands } from "../state/commands";
import { fromAgent, type Review } from "../state/review";
import { AGENT } from "./ThreadCard";

const base = (path: string) => path.split("/").pop() ?? path;

function describe(item: ActivityItem): { what: string; where: string } {
  return match(item.kind)
    .with({ type: "opened" }, ({ notes, collapsed }) => ({
      what: `${AGENT} opened the review`,
      where: [notes ? `${notes} notes` : "", collapsed ? `${collapsed} collapsed` : ""]
        .filter(Boolean)
        .join(" · "),
    }))
    .with({ type: "userCommented" }, ({ path, line }) => ({
      what: "You commented",
      where: `${base(path)}:${line}`,
    }))
    .with({ type: "agentReplied" }, ({ path, line }) => ({
      what: `${AGENT} replied`,
      where: `${base(path)}:${line}`,
    }))
    .with({ type: "agentNoted" }, ({ path, line }) => ({
      what: `${AGENT} added a note`,
      where: `${base(path)}:${line}`,
    }))
    .with({ type: "revision" }, ({ revision, paths }) => ({
      what: `Revision ${revision} · ${paths.length} file${paths.length === 1 ? "" : "s"}`,
      where: paths.map(base).slice(0, 3).join(" · "),
    }))
    .with({ type: "agentSaid" }, () => ({ what: `${AGENT} wrote in the chat`, where: "" }))
    .with({ type: "show" }, ({ request }) => ({
      what: `${AGENT} wants to show you something`,
      where: `${base(request.path)}:${request.start}`,
    }))
    .exhaustive();
}

/** A quiet feed of what happened, newest first. Agent activity you haven't seen is marked. */
export function Activity(props: { review: Review; cmd: Commands }) {
  const items = () => [...props.review.conv.activity].reverse();
  const isUnread = (a: ActivityItem) => a.seq > props.review.conv.readSeq && fromAgent(a);
  return (
    <section aria-label="Activity">
      <Show when={props.review.unread().length > 0}>
        <div class="flex justify-end px-2.5 pt-1">
          <button
            type="button"
            class="cursor-pointer text-[10.5px] text-muted hover:text-fg"
            onClick={() => props.review.markRead(props.review.conv.activity.at(-1)?.seq ?? 0)}
          >
            Mark all read
          </button>
        </div>
      </Show>
      <ol class="flex flex-col gap-px px-1.5 pt-1 pb-2">
        <For each={items()}>
          {(item) => {
            const d = describe(item);
            return (
              <li>
                <button
                  type="button"
                  class="grid w-full cursor-pointer grid-cols-[10px_minmax(0,1fr)] gap-x-2 rounded px-1.5 py-1 text-left text-xs hover:bg-hover"
                  onClick={() => props.cmd.activityGo(item)}
                >
                  <span
                    class="mt-[5px] size-[7px] rounded-full border-[1.5px]"
                    classList={{
                      "border-accent bg-accent": isUnread(item),
                      "border-subtle": !isUnread(item),
                    }}
                  />
                  <span classList={{ "font-medium text-fg": isUnread(item), "text-muted": !isUnread(item) }}>
                    {d.what}
                  </span>
                  <span class="col-start-2 flex justify-between gap-1.5 font-mono text-[10.5px] text-subtle">
                    <span class="truncate">{d.where}</span>
                    <span class="flex-none">{ago(item.at)}</span>
                  </span>
                </button>
              </li>
            );
          }}
        </For>
      </ol>
    </section>
  );
}
