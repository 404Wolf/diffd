import { createEffect, createSignal, For, onCleanup } from "solid-js";
import type { ActivityItem } from "../api";
import { agentName } from "../lib/agent";
import type { Commands } from "../state/commands";
import type { Review } from "../state/review";

/** How long a toast stays when it isn't clicked. */
const TOAST_MS = 12_000;
const MAX_TOASTS = 3;
const PREVIEW_CHARS = 110;

/**
 * "Codex replied": a small card in the corner of the code for each answer
 * that arrives while you're reading. Clicking it goes to the reply. Toasts go
 * once read (here or in another tab) or after a while.
 */
export function ReplyToasts(props: { review: Review; cmd: Commands }) {
  const [toasts, setToasts] = createSignal<ActivityItem[]>([]);
  // Only what arrives from now on: the backlog is in the activity feed.
  let seen = props.review.conv.activity.at(-1)?.seq ?? 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  onCleanup(() => {
    for (const t of timers) clearTimeout(t);
  });
  const dismiss = (seq: number) => setToasts((ts) => ts.filter((t) => t.seq !== seq));
  createEffect(() => {
    const activity = props.review.conv.activity;
    const fresh = activity.filter(
      (a) => a.seq > seen && (a.kind.type === "agentReplied" || a.kind.type === "agentSaid"),
    );
    seen = Math.max(seen, activity.at(-1)?.seq ?? 0);
    if (fresh.length === 0) return;
    setToasts((ts) => [...ts, ...fresh].slice(-MAX_TOASTS));
    for (const item of fresh) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        dismiss(item.seq);
      }, TOAST_MS);
      timers.add(timer);
    }
  });
  const unread = () => toasts().filter((t) => t.seq > props.review.conv.readSeq);

  /** The start of what the agent said. */
  const preview = (item: ActivityItem): string => {
    const k = item.kind;
    const body =
      k.type === "agentReplied"
        ? props.review
            .threads()
            .find((t) => t.id === k.threadId)
            ?.messages.findLast((m) => m.author === "agent")?.body
        : k.type === "agentSaid"
          ? props.review.chat().find((m) => m.id === k.messageId)?.body
          : undefined;
    const line = (body ?? "")
      .replace(/[`*_#>]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS)}…` : line;
  };
  const where = (item: ActivityItem) =>
    item.kind.type === "agentReplied"
      ? `on ${item.kind.path.split("/").pop()}:${item.kind.line}`
      : "in the chat";

  return (
    <div class="pointer-events-none absolute right-3 bottom-3 z-20 flex w-[min(340px,calc(100%-24px))] flex-col gap-1.5">
      <For each={unread()}>
        {(item) => (
          <div
            role="status"
            class="pointer-events-auto flex items-start gap-2 rounded-lg border border-accent-line bg-bg py-1.5 pr-1.5 pl-2.5 text-xs shadow-pop"
            data-toast={item.kind.type}
          >
            <button
              type="button"
              class="min-w-0 flex-1 cursor-pointer text-left"
              title="Go to the reply"
              onClick={() => {
                dismiss(item.seq);
                props.cmd.activityGo(item);
              }}
            >
              <b class="font-semibold">
                ✦ {agentName()} replied <span class="font-normal text-muted">{where(item)}</span>
              </b>
              <span class="line-clamp-2 text-muted">{preview(item)}</span>
            </button>
            <button
              type="button"
              class="flex-none cursor-pointer rounded px-1 text-subtle hover:bg-hover hover:text-fg"
              aria-label="Dismiss"
              onClick={() => dismiss(item.seq)}
            >
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
