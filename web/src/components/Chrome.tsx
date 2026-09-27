import { Dialog } from "@kobalte/core/dialog";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { match } from "ts-pattern";
import { agentName } from "../lib/agent";
import { diagnosticsOn } from "../lib/code";
import { spanLabel } from "../lib/history";
import { composing } from "../lib/keymap";
import { helpEntries } from "../state/bindings";
import type { Commands } from "../state/commands";
import { bufferEl } from "../state/dom";
import type { LayoutState } from "../state/layout";
import type { Review } from "../state/review";
import type { PickerItem, View } from "../state/view";

export function TopBar(props: { review: Review }) {
  const meta = () => props.review.meta();
  const totals = createMemo(() =>
    props.review
      .snapshot()
      .files.reduce((t, f) => ({ add: t.add + f.added, del: t.del + f.removed }), { add: 0, del: 0 }),
  );
  const queued = () => {
    const n = props.review.pendingCount();
    return n === 0 ? "" : ` · ${n} queued`;
  };
  const presence = () =>
    match([props.review.connection(), props.review.conv.presence] as const)
      .with(["gone", "listening"], ["gone", "working"], ["gone", "away"], () => ({
        dot: "bg-del",
        text: "This review was deleted",
      }))
      .with(["offline", "listening"], ["offline", "working"], ["offline", "away"], () => ({
        dot: "bg-subtle",
        text: `Offline${queued() || " · reconnecting"}`,
      }))
      .with(["connecting", "listening"], ["connecting", "working"], ["connecting", "away"], () => ({
        dot: "bg-subtle",
        text: `Connecting…${queued()}`,
      }))
      .with(["live", "listening"], () => ({ dot: "bg-live", text: `${agentName()} is listening` }))
      .with(["live", "working"], () => ({ dot: "bg-warn animate-pulse", text: `${agentName()} is working` }))
      .with(["live", "away"], () => ({ dot: "bg-subtle", text: `${agentName()} hasn't checked in` }))
      .exhaustive();
  return (
    <header class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel px-2.5 py-1">
      <a
        href="/"
        class="flex items-center gap-1.5 font-mono text-[12.5px] font-semibold text-fg no-underline"
      >
        <i class="size-2 rotate-45 rounded-[2px] bg-accent" />
        diffd
      </a>
      <span class="min-w-0 truncate text-[13.5px] font-semibold">{meta().title}</span>
      <span class="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <span>{meta().repoName}</span>
        <Rev>{meta().from}</Rev>→<Rev>{meta().to ?? "working tree"}</Rev>
        <span>· rev {meta().revision}</span>
      </span>
      {/* The commits on their way show right away, pulsing until they're ready. */}
      <Show when={(props.review.loadingSpan() ?? props.review.span()) !== null}>
        <span
          class="inline-flex h-[22px] items-center gap-1 rounded-full border border-accent-line bg-accent-soft pr-0.5 pl-2 text-xs text-accent"
          classList={{ "animate-pulse": props.review.loadingSpan() !== undefined }}
          aria-busy={props.review.loadingSpan() !== undefined}
          data-span-chip
        >
          <span class="font-mono text-[11px]">
            {spanLabel(props.review.history(), props.review.loadingSpan() ?? props.review.span())}
          </span>
          <button
            type="button"
            title="Back to all changes"
            aria-label="Back to all changes"
            class="grid size-[18px] cursor-pointer place-items-center rounded-full hover:bg-bg"
            onClick={() => void props.review.showSpan(null)}
          >
            ×
          </button>
        </span>
      </Show>
      <span class="flex gap-2 font-mono text-[11.5px] text-muted tabular-nums">
        <span>{props.review.diffCount()} files</span>
        <span class="text-add">+{totals().add}</span>
        <span class="text-del">−{totals().del}</span>
      </span>
      <span class="flex-1" />
      <span
        id="presence"
        class="inline-flex h-6 items-center gap-1.5 rounded-full border border-line bg-bg px-2.5 text-xs font-medium whitespace-nowrap"
      >
        <span class={`size-[7px] rounded-full ${presence().dot}`} />
        {presence().text}
      </span>
    </header>
  );
}

function Rev(props: { children: JSX.Element }) {
  return (
    <span class="rounded border border-line bg-inset px-1.5 font-mono text-[11.5px] text-fg">
      {props.children}
    </span>
  );
}

export function StatusLine(props: { review: Review; view: View; layout: LayoutState; mode: () => string }) {
  const position = createMemo(() => {
    const c = props.view.cursor();
    if (!c) return "no cursor";
    const file = props.review.snapshot().files[c.file];
    const row = file?.rows[c.row];
    const line = row ? (c.side === "old" ? row[0] : row[1]) : null;
    const name = file?.path.split("/").pop() ?? "";
    return `${name}:${line === null || line === undefined ? "-" : line + 1} ${c.side}${c.word ? ` · ${c.word.text}` : ""}`;
  });
  /** Which hunk the cursor is in, of how many: over the pane's list, by binary search. */
  const hunk = createMemo(() => {
    const c = props.view.cursor();
    if (props.view.mode().kind !== "diff") return "";
    const { hunks } = props.layout.layout();
    const at = c ? props.layout.indexOfRow(c.file, c.row) : -1;
    let lo = 0;
    let hi = hunks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((hunks[mid] as number) <= at) lo = mid + 1;
      else hi = mid;
    }
    return `hunk ${at < 0 ? 0 : lo}/${hunks.length}`;
  });
  /** Which chapter of the agent's tour the cursor is in, when reading the tour. */
  const chapter = createMemo(() => {
    if (!props.review.grouped()) return "";
    const c = props.view.cursor();
    const at = c ? props.review.groupOf(props.review.snapshot().files[c.file]?.path ?? "") : -1;
    return at < 0 ? "" : `ch ${at + 1}/${props.review.groups().length}`;
  });
  /** The worst diagnostic on the cursor's line, like an editor's status bar. */
  const lineDiagnostic = createMemo(() => {
    const c = props.view.cursor();
    const file = c ? props.review.snapshot().files[c.file] : undefined;
    const line = c && file ? file.rows[c.row]?.[1] : null;
    if (!c || !file || c.side !== "new" || line === null || line === undefined) return null;
    return diagnosticsOn(props.review.conv.diagnostics[file.path], line + 1)[0] ?? null;
  });
  const hint = () =>
    match(props.mode())
      .with("SYMBOL", () => "w b next / previous symbol · enter or gd to definition · ctrl-o back · esc")
      .with("FILE", () => "ctrl-o back to the diff · w symbols · gd definition")
      .with("VISUAL", () => "j k extend · gc comment · esc")
      .otherwise(() => "]c hunk · ]f file · ge expand · w symbols · gcc comment · g enter file · ? keys");
  const modeColor = () =>
    match(props.mode())
      .with("VISUAL", () => "bg-warn text-bg")
      .with("SYMBOL", () => "bg-[var(--syn-function)] text-bg")
      .with("FILE", () => "bg-fg text-bg")
      .with("INSERT", () => "bg-add text-bg")
      .otherwise(() => "bg-accent text-accent-fg");
  return (
    <footer class="flex h-6 items-center gap-3 overflow-hidden border-t border-line bg-panel px-2.5 font-mono text-[11px] whitespace-nowrap text-muted">
      <span class={`rounded-[3px] px-1.5 font-semibold tracking-wide ${modeColor()}`}>{props.mode()}</span>
      <span>{position()}</span>
      <Show when={hunk()}>
        <span>{hunk()}</span>
      </Show>
      <Show when={chapter()}>{(ch) => <span data-chapter-status>{ch()}</span>}</Show>
      <span>
        jumps {props.view.jumpPos().at}/{props.view.jumpPos().length}
      </span>
      <span class="min-w-[3ch] text-fg">{props.view.pending()}</span>
      <span>rev {props.review.meta().revision}</span>
      <Show
        when={!props.view.message() && lineDiagnostic()}
        fallback={<span class="ml-auto hidden font-sans md:inline">{props.view.message() || hint()}</span>}
      >
        {(d) => (
          <span
            data-line-diagnostic
            class="ml-auto min-w-0 truncate font-sans"
            classList={{ "text-del": d().severity === "error", "text-warn": d().severity === "warning" }}
          >
            {d().severity}: {d().message.split("\n")[0]} <span class="text-subtle">· K for more</span>
          </span>
        )}
      </Show>
    </footer>
  );
}

/** "Claude wants to show you something": the agent never moves your scroll by itself. */
export function Nudge(props: { view: View; cmd: Commands }) {
  return (
    <Show when={props.view.nudge()}>
      {(req) => (
        <div class="absolute top-2.5 left-1/2 z-[15] flex w-[min(520px,calc(100%-24px))] -translate-x-1/2 flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg border border-accent-line bg-bg py-1.5 pr-2 pl-3 text-[12.5px] shadow-pop">
          <div class="min-w-0 flex-[1_1_240px]">
            <b class="font-semibold">✦ {agentName()} wants to show you something</b>
            <div class="truncate font-mono text-[11px] text-muted">
              {req().path.split("/").pop()}:{req().start} · {req().message}
            </div>
          </div>
          <button
            type="button"
            class="cursor-pointer rounded-md px-2 py-1 text-xs text-muted hover:bg-hover"
            onClick={() => props.cmd.nudgeDone(false)}
          >
            Later <kbd>esc</kbd>
          </button>
          <button
            type="button"
            class="inline-flex cursor-pointer items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg"
            onClick={() => props.cmd.nudgeDone(true)}
          >
            Show me <kbd>↵</kbd>
          </button>
        </div>
      )}
    </Show>
  );
}

/** A binding as you'd type it: `] c` as `]c`, but `space t g` and `g enter` keep their spaces. */
export const keyLabel = (keys: string): string => {
  const parts = keys.split(" ");
  return parts.some((k) => k.length > 1) ? keys : parts.join("");
};

const fuzzy = (q: string, s: string) => {
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length;
};

export function Picker(props: { view: View }) {
  const [query, setQuery] = createSignal("");
  const [sel, setSel] = createSignal(0);
  const items = createMemo<readonly PickerItem[]>(() => {
    const p = props.view.picker();
    if (!p) return [];
    const q = query().trim().toLowerCase();
    // A literal picker (search) gets the query as typed; it matches case-insensitively itself.
    const all = p.items(p.literal ? query().trim() : q);
    return (
      p.literal || !q ? all : all.filter((it) => fuzzy(q, `${it.label} ${it.detail}`.toLowerCase()))
    ).slice(0, 300);
  });
  const close = () => {
    props.view.setPicker(null);
    setQuery("");
    setSel(0);
    bufferEl()?.focus({ preventScroll: true });
  };
  const pick = (i: number) => {
    const it = items()[i];
    close();
    it?.run();
  };
  const onKey = (e: KeyboardEvent) => {
    if (composing(e)) return;
    const n = items().length;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setSel((s) => Math.min(n - 1, s + 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(sel());
    }
  };
  return (
    <Dialog open={props.view.picker() !== null} onOpenChange={(open) => !open && close()}>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-30 bg-[color-mix(in_srgb,var(--page)_65%,transparent)] backdrop-blur-[2px]" />
        <div class="fixed inset-0 z-30 grid place-items-start justify-center p-4 pt-[12vh]">
          <Dialog.Content class="w-[min(640px,100vw-32px)] rounded-xl border border-line-strong bg-bg p-3 shadow-pop">
            <Dialog.Title class="mb-2 text-sm font-semibold">{props.view.picker()?.title}</Dialog.Title>
            <input
              autofocus
              value={query()}
              onInput={(e) => {
                setQuery(e.currentTarget.value);
                setSel(0);
              }}
              onKeyDown={onKey}
              aria-label="Filter"
              class="h-8 w-full rounded-md border border-line-strong bg-bg px-2.5 focus:border-accent focus:outline-none"
            />
            <Show when={props.view.picker()?.status?.(query().trim())}>
              {(status) => (
                <p class="mt-1.5 px-1 text-[11.5px] text-muted" data-picker-status>
                  {status()}
                </p>
              )}
            </Show>
            <ol class="mt-2 max-h-[min(52vh,420px)] overflow-auto">
              <For
                each={items()}
                fallback={
                  <li class="px-2 py-1.5 text-subtle">
                    {query().length < 2 && props.view.picker()?.literal
                      ? "Type at least 2 characters"
                      : "No matches"}
                  </li>
                }
              >
                {(it, i) => (
                  <li>
                    <button
                      type="button"
                      class="grid w-full cursor-pointer grid-cols-[minmax(0,max-content)_minmax(0,1fr)] items-baseline gap-3 rounded px-2 py-1 text-left text-[12.5px]"
                      classList={{ "bg-accent-soft": i() === sel() }}
                      onMouseEnter={() => setSel(i())}
                      onClick={() => pick(i())}
                    >
                      <span class="truncate">{it.label}</span>
                      <span class="truncate font-mono text-[11.5px] text-muted">{it.detail}</span>
                    </button>
                  </li>
                )}
              </For>
            </ol>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}

export function Help(props: { view: View }) {
  const groups = () => {
    const by = new Map<string, { label: string; keys: string[] }[]>();
    for (const e of helpEntries()) by.set(e.group, [...(by.get(e.group) ?? []), e]);
    return [...by.entries()];
  };
  return (
    <Dialog open={props.view.help()} onOpenChange={props.view.setHelp}>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-30 bg-[color-mix(in_srgb,var(--page)_65%,transparent)] backdrop-blur-[2px]" />
        <div class="fixed inset-0 z-30 grid place-items-center p-4">
          <Dialog.Content class="max-h-[84vh] w-[min(820px,100vw-32px)] overflow-auto rounded-xl border border-line-strong bg-bg px-4 pt-3.5 pb-4 shadow-pop">
            <div class="mb-1 flex items-center gap-2">
              <Dialog.Title class="text-sm font-semibold">Keys</Dialog.Title>
              <span class="flex-1" />
              <Dialog.CloseButton class="cursor-pointer rounded-md px-2 py-1 text-xs text-muted hover:bg-hover">
                Close <kbd>esc</kbd>
              </Dialog.CloseButton>
            </div>
            <p class="mb-2 text-xs text-muted">
              Vim-style, mostly from Zed's vim keymap. Leader is <kbd>space</kbd>. Browser <kbd>ctrl</kbd>{" "}
              <kbd>f</kbd> is never intercepted and finds text in folded lines too.
            </p>
            <div class="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-x-6">
              <For each={groups()}>
                {([group, entries]) => (
                  <>
                    <h3 class="col-span-full mt-2.5 mb-0.5 text-[10.5px] font-semibold tracking-wider text-muted uppercase">
                      {group}
                    </h3>
                    <For each={entries}>
                      {(e) => (
                        <div class="flex items-center justify-between gap-2.5 border-b border-line py-1 text-[12.5px]">
                          <span>{e.label}</span>
                          <span class="flex flex-wrap justify-end gap-1">
                            <For each={e.keys}>{(k) => <kbd>{keyLabel(k)}</kbd>}</For>
                          </span>
                        </div>
                      )}
                    </For>
                  </>
                )}
              </For>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}
