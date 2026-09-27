import { For, Show } from "solid-js";
import { match } from "ts-pattern";
import type { Message, Thread } from "../api";
import { agentName } from "../lib/agent";
import { ago } from "../lib/time";
import type { Commands } from "../state/commands";
import type { Review } from "../state/review";
import { Markdown } from "./Markdown";

const range = (t: Thread) =>
  t.anchor.start === t.anchor.end ? `L${t.anchor.start}` : `L${t.anchor.start}–${t.anchor.end}`;

/** Where a user message is on its way to the agent. */
function delivery(msg: Message, thread: Thread, review: Review): string {
  if (review.isPending(msg.id)) return review.connection() === "live" ? "Sending…" : "Queued offline";
  const later = thread.messages.slice(thread.messages.indexOf(msg) + 1);
  if (later.some((m) => m.author === "agent")) return `${agentName()} replied`;
  return msg.deliveredAt === null ? "Sent" : `Seen by ${agentName()}`;
}

function Avatar(props: { agent: boolean }) {
  return (
    <div
      class="row-span-2 grid size-[18px] place-items-center rounded-full text-[9.5px] font-semibold"
      classList={{ "bg-accent-soft text-accent": props.agent, "bg-inset text-muted": !props.agent }}
    >
      {props.agent ? "✦" : "Y"}
    </div>
  );
}

export function ThreadCard(props: { thread: Thread; review: Review; cmd: Commands; noteNumber?: number }) {
  const t = () => props.thread;
  const note = () => {
    const kind = t().kind;
    return kind.type === "note" ? kind : null;
  };
  return (
    <div
      data-thread={t().id}
      class="max-w-[720px] scroll-mt-11 overflow-hidden rounded-md border bg-bg font-sans text-[12px] leading-snug"
      classList={{
        "border-accent-line": note() !== null,
        "border-line-strong": note() === null,
        "opacity-70": t().resolved,
      }}
    >
      <Show when={t().changedIn !== null}>
        <div class="border-b border-line bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] px-2.5 py-1 text-[11.5px] text-warn">
          {t().outdated
            ? "This code is no longer in the diff."
            : `These lines changed in revision ${t().changedIn} after the thread started.`}
        </div>
      </Show>
      <div class="flex flex-wrap items-center gap-x-2 px-2 pt-1 text-[11px] text-muted">
        <Show when={note()}>
          {(n) => (
            <span
              class="text-[10px] font-semibold tracking-wider uppercase"
              classList={{ "text-del": n().kind === "risk", "text-accent": n().kind !== "risk" }}
            >
              ✦ {n().kind}
            </span>
          )}
        </Show>
        <span class="font-mono text-[11px]">
          {t().anchor.side} {range(t())}
        </span>
        <Show when={t().resolved}>
          <span class="text-[10px] font-semibold tracking-wider text-muted uppercase">resolved</span>
        </Show>
        <Show when={props.noteNumber !== undefined}>
          <span class="ml-auto tabular-nums">note {props.noteNumber}</span>
        </Show>
      </div>
      <For each={t().messages}>
        {(m) => (
          <div
            data-message={m.id}
            class="grid grid-cols-[18px_minmax(0,1fr)] gap-x-2 border-line px-2 py-1 [&+&]:border-t"
            classList={{ "opacity-75": props.review.isPending(m.id) }}
            data-pending={props.review.isPending(m.id) ? "" : undefined}
          >
            <Avatar agent={m.author === "agent"} />
            <div class="flex flex-wrap items-baseline gap-x-2 text-xs">
              <b class="font-semibold">{m.author === "agent" ? agentName() : "You"}</b>
              <span class="text-[11px] text-subtle">{ago(m.createdAt)}</span>
              <Show when={m.author === "user"}>
                <span
                  class="text-[10.5px] font-medium"
                  classList={{
                    "text-accent": m.deliveredAt !== null,
                    "text-subtle": m.deliveredAt === null && !props.review.isPending(m.id),
                    "text-warn": props.review.isPending(m.id),
                  }}
                >
                  · {delivery(m, t(), props.review)}
                </span>
              </Show>
            </div>
            <Markdown text={m.body} paths={props.review.paths()} class="max-w-[72ch]" />
          </div>
        )}
      </For>
      <div class="flex gap-0.5 border-t border-line px-1 py-px">
        <FootButton onClick={() => props.cmd.replyTo(t())}>
          Reply <kbd>r</kbd>
        </FootButton>
        {match(t().kind.type)
          .with("comment", () => (
            <FootButton onClick={() => props.review.resolve(t().id, !t().resolved)}>
              {t().resolved ? "Reopen" : "Resolve"}
            </FootButton>
          ))
          .with("note", () => (
            <FootButton onClick={() => props.cmd.noteJump(1)}>
              Next note <kbd>]a</kbd>
            </FootButton>
          ))
          .exhaustive()}
      </div>
    </div>
  );
}

function FootButton(props: { onClick: () => void; children: import("solid-js").JSX.Element }) {
  return (
    <button
      type="button"
      class="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-muted hover:bg-hover hover:text-fg"
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
