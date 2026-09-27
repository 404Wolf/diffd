/**
 * The multibuffer: every file's items (header, rows, gaps, threads) as one
 * flat list (`state/layout.ts`), windowed (`WindowedList.tsx`) so only the
 * items near the viewport are in the DOM, with the header of the file at the
 * top of the screen kept over its rows.
 */

import { createRenderEffect, createSignal, For, type JSX, Show } from "solid-js";
import { match } from "ts-pattern";
import type { FileDiff, Omitted, Thread } from "../api";
import { gapContext, regionRows } from "../lib/diffModel";
import { rowHtml, soloSide } from "../lib/render";
import { STATUS } from "../lib/status";
import { ROW_PX, wrappedLines } from "../lib/windower";
import type { Commands } from "../state/commands";
import type { Item, LayoutState, RowItem } from "../state/layout";
import type { Review } from "../state/review";
import type { Pane, View } from "../state/view";
import { Markdown } from "./Markdown";
import { ThreadCard } from "./ThreadCard";
import { type ListView, WindowedList } from "./WindowedList";

/** The file header's height: the sticky one covers this much of the top of the viewport. */
const HEAD_PX = 26;
/** The code cell's horizontal padding, and the width of the two line number columns. */
export const CODE_PAD_PX = 18;
const NUMS_PX = 88;
/** The file card's side margins and borders. */
const CARD_INSET_PX = 16 + 2;
/** The space above a file's card, in its header item. */
const CARD_GAP_PX = 6;

const OMITTED: Record<Omitted, string> = {
  binary: "Binary file, not shown.",
  tooLarge: "Too large to show (over 3 MB).",
  submodule: "A submodule: its commits aren't shown here.",
};

/** The file card's edge: green for a new file, red for a deleted one. */
const edge = (f: FileDiff | undefined): string =>
  f?.status === "added"
    ? "border-add-mark"
    : f?.status === "deleted"
      ? "border-del-mark"
      : "border-line-strong";

/** The sides of a file's card, around one of its items. */
function Card(props: { review: Review; file: number; class?: string; children: JSX.Element }) {
  return (
    <div
      class={`mx-2 border-x bg-bg ${edge(props.review.snapshot().files[props.file])} ${props.class ?? ""}`}
    >
      {props.children}
    </div>
  );
}

interface Props {
  review: Review;
  view: View;
  cmd: Commands;
  layout: LayoutState;
  pane: Pane;
  /** The pane's scrolling element. */
  buf: () => HTMLElement | undefined;
}

export function Multibuffer(props: Props) {
  /** Characters per line in a code column, for estimating how lines wrap. */
  let columns = 80;
  /** The same for a new or deleted file's single column (`.solo`). */
  let soloColumns = 80;
  const onWidth = (width: number, charWidth: number) => {
    columns = Math.max(8, Math.floor(((width - CARD_INSET_PX - NUMS_PX) / 2 - CODE_PAD_PX) / charWidth));
    // `.solo`: max(50%, min(100%, 640px)) of the card, one gutter, its own side borders.
    const card = width - CARD_INSET_PX;
    const solo = Math.max(card / 2, Math.min(card, 640));
    soloColumns = Math.max(8, Math.floor((solo - 2 - NUMS_PX / 2 - CODE_PAD_PX) / charWidth));
  };

  const files = () => props.review.snapshot().files;
  const estimate = (item: Item): number =>
    match(item)
      .with({ kind: "row" }, ({ file, row }) => {
        const f = files()[file];
        const r = f?.rows[row];
        if (!f || !r) return ROW_PX;
        const cols = soloSide(f) === null ? columns : soloColumns;
        const old = r[0] === null ? 1 : wrappedLines(f.old?.lines[r[0]] ?? "", cols);
        const neu = r[1] === null ? 1 : wrappedLines(f.new?.lines[r[1]] ?? "", cols);
        return ROW_PX * Math.max(old, neu);
      })
      .with({ kind: "group" }, () => 60)
      .with({ kind: "head" }, () => CARD_GAP_PX + 1 + HEAD_PX + 1)
      .with({ kind: "notice" }, () => 26)
      .with({ kind: "gap" }, () => 22)
      .with({ kind: "threads" }, ({ file, row }) => 10 + 90 * props.layout.threadsAt(file, row).length)
      .with({ kind: "end" }, () => 13)
      .with({ kind: "summary" }, () => 60)
      .exhaustive();

  const [sticky, setSticky] = createSignal<{ file: number; shift: number } | null>(null, {
    equals: (a, b) => a?.file === b?.file && a?.shift === b?.shift,
  });
  /** The sticky header: the file at the top of the screen, once its own header has scrolled off. */
  const onView = (v: ListView) => {
    const item = v.items[v.indexAt(Math.max(0, v.top) + 1)];
    if (!item || item.kind === "summary" || item.kind === "group") return setSticky(null);
    const head = props.layout.headIndex(item.file);
    // Below the header's top padding: it's the card's own top edge.
    if (v.offset(head) + CARD_GAP_PX >= v.top) return setSticky(null);
    // The card's bottom edge pushes the header up, as `position: sticky` does.
    const cardEnd = v.offset(props.layout.layout().fileStart[item.file + 1] ?? v.items.length) - CARD_GAP_PX;
    setSticky({ file: item.file, shift: Math.min(0, cardEnd - v.top - HEAD_PX) });
  };

  const render = (item: Item): JSX.Element =>
    match(item)
      .with({ kind: "row" }, (r) => <RowView item={r} review={props.review} layout={props.layout} />)
      .with({ kind: "group" }, ({ file }) => <ChapterHeader file={file} review={props.review} />)
      .with({ kind: "head" }, ({ file }) => (
        <div class="pt-1.5">
          <Card review={props.review} file={file} class="overflow-clip rounded-t-md border-t">
            <FileHead file={file} review={props.review} view={props.view} cmd={props.cmd} />
          </Card>
        </div>
      ))
      .with({ kind: "notice" }, (n) => <Notice item={n} review={props.review} cmd={props.cmd} />)
      .with({ kind: "gap" }, (g) => <Gap item={g} review={props.review} cmd={props.cmd} />)
      .with({ kind: "threads" }, (t) => (
        <Threads item={t} review={props.review} layout={props.layout} cmd={props.cmd} />
      ))
      .with({ kind: "end" }, ({ file }) => (
        <div class="pb-1.5">
          <Card review={props.review} file={file} class="h-1.5 rounded-b-md border-b">
            {null}
          </Card>
        </div>
      ))
      .with({ kind: "summary" }, () => (
        <div class="px-2 pt-2 pb-0.5">
          <Summary review={props.review} cmd={props.cmd} />
        </div>
      ))
      .exhaustive();

  return (
    <>
      {/* The header of the file at the top of the screen, over its rows. */}
      <div class="sticky top-0 z-[3] h-0">
        <Show when={sticky()}>
          {(s) => (
            <div style={{ transform: `translateY(${s().shift}px)` }}>
              <Card review={props.review} file={s().file} class="overflow-clip">
                <FileHead file={s().file} review={props.review} view={props.view} cmd={props.cmd} />
              </Card>
            </div>
          )}
        </Show>
      </div>
      <WindowedList
        pane={props.pane}
        buf={props.buf}
        nav={props.layout}
        estimate={estimate}
        onWidth={onWidth}
        render={render}
        topInset={HEAD_PX}
        onView={onView}
        groupOf={(item) => (item.kind === "summary" ? "" : String(item.file))}
        wrap={(key, children) =>
          key === "" ? children : <section data-file-section={key}>{children}</section>
        }
      />
      <Show when={props.review.diffCount() === 0}>
        <p class="p-6 text-center text-muted">
          {props.review.hiddenCount() > 0
            ? `All ${props.review.hiddenCount()} files are hidden by labels; show them from the files drawer.`
            : "No changes between these revisions."}
        </p>
      </Show>
    </>
  );
}

/**
 * One aligned row, as HTML (`lib/render.ts`); rebuilt when its file's marks
 * change. A new or deleted file's row is one centred column (`.solo`).
 */
function RowView(props: { item: RowItem; review: Review; layout: LayoutState }) {
  const el = document.createElement("div");
  createRenderEffect(() => {
    const f = props.review.snapshot().files[props.item.file];
    const marks = props.layout.marks(props.item.file);
    el.className = `mx-2 border-x bg-bg ${edge(f)}`;
    const html = f && marks ? rowHtml(props.item.file, props.item.row, f, marks) : "";
    const solo = f ? soloSide(f) : null;
    el.innerHTML = solo ? `<div class="solo solo-${solo}">${html}</div>` : html;
  });
  return el;
}

/** Where a chapter of the agent's tour starts: its number, title and what it's about. */
function ChapterHeader(props: { file: number; review: Review }) {
  const group = () => props.review.groupAt(props.review.paths()[props.file] ?? "");
  const number = () => {
    const g = group();
    return g ? props.review.groups().indexOf(g) + 1 : 0;
  };
  return (
    <div class="px-2.5 pt-3 pb-0.5">
      <header
        class="flex items-baseline gap-2 border-t border-line pt-2 font-sans text-[12.5px] whitespace-normal"
        data-group={group()?.title}
      >
        <span class="shrink-0 font-mono text-[11px] text-subtle">
          {number()}/{props.review.groups().length}
        </span>
        <div class="min-w-0">
          <h2 class="inline font-semibold text-fg">{group()?.title}</h2>
          <Show when={group()?.summary}>
            {(summary) => (
              <Markdown
                text={summary()}
                paths={props.review.paths()}
                class="max-w-[90ch] text-xs text-muted"
              />
            )}
          </Show>
        </div>
      </header>
    </div>
  );
}

/** The tour's chapters, as a line of links: the table of contents. */
function Contents(props: { review: Review; cmd: Commands }) {
  return (
    <nav aria-label="Tour" class="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[11.5px]">
      <span class="text-muted">
        Tour <kbd>]g</kbd>
      </span>
      <For each={props.review.groups()}>
        {(g, i) => (
          <button
            type="button"
            class="cursor-pointer text-muted hover:text-fg hover:underline"
            data-chapter={i()}
            title={g.summary ?? g.title}
            onClick={() => props.cmd.chapterGo(i())}
          >
            <span class="font-mono text-subtle">{i() + 1}</span> {g.title}
          </button>
        )}
      </For>
    </nav>
  );
}

function FileHead(props: { file: number; review: Review; view: View; cmd: Commands }) {
  const file = () => props.review.snapshot().files[props.file];
  const path = () => file()?.path ?? "";
  const dir = () => (path().includes("/") ? path().slice(0, path().lastIndexOf("/") + 1) : "");
  const hidden = () => props.view.hidden(props.file);
  const regions = () => props.review.regions().filter((r) => r.path === path() && r.kind === "test");
  return (
    <div
      data-file-head
      class="flex h-[26px] items-center gap-2 border-line px-2 text-xs"
      classList={{
        "border-b": !hidden(),
        "bg-panel": file()?.status !== "added" && file()?.status !== "deleted",
        "bg-add-bg": file()?.status === "added",
        "bg-del-bg": file()?.status === "deleted",
      }}
    >
      <button
        type="button"
        class="size-[18px] cursor-pointer rounded text-[9px] text-subtle hover:bg-hover hover:text-fg"
        classList={{ "-rotate-90": hidden() }}
        aria-label={hidden() ? `Expand ${path()}` : `Collapse ${path()}`}
        onClick={() => props.cmd.toggleFold(props.file)}
      >
        ▼
      </button>
      <Show when={file()}>
        {(f) => (
          <>
            <span class={`w-3 text-center font-mono text-[10px] font-semibold ${STATUS[f().status].color}`}>
              {STATUS[f().status].letter}
            </span>
            <span
              class="min-w-0 flex-1 truncate font-mono text-xs font-medium"
              title={path()}
              data-path={path()}
            >
              <Show when={f().oldPath}>{(old) => <span class="text-muted">{old()} → </span>}</Show>
              <span class="font-normal text-muted">{dir()}</span>
              {path().slice(dir().length)}
            </span>
            <Show when={f().status === "added" || f().status === "deleted"}>
              <span
                class="rounded px-1.5 text-[11px] font-semibold text-bg"
                classList={{ "bg-add": f().status === "added", "bg-del": f().status === "deleted" }}
              >
                {f().status === "added" ? "New file" : "Deleted"}
              </span>
            </Show>
            <Show when={f().collapsed}>
              {(reason) => (
                <span
                  class="rounded bg-accent-soft px-1.5 text-[11px] text-accent"
                  title="Collapsed when the review was shared"
                >
                  ✦ {reason()}
                </span>
              )}
            </Show>
            <Show when={regions().length > 0}>
              <span
                class="rounded bg-[color-mix(in_srgb,var(--test)_14%,transparent)] px-1.5 text-[11px] text-[var(--test)]"
                title="Marked as tests by the agent"
              >
                {regions().some((r) => r.lines === null) ? "test file" : "has tests"}
              </span>
            </Show>
            <Show when={f().language}>
              {(lang) => <span class="rounded bg-inset px-1.5 text-[11px] text-muted">{lang()}</span>}
            </Show>
            <span class="flex gap-1.5 font-mono text-[11.5px] tabular-nums">
              <span class="text-add">+{f().added}</span>
              <span class="text-del">−{f().removed}</span>
            </span>
            <label class="inline-flex cursor-pointer items-center gap-1 text-[11.5px] text-muted">
              <input
                type="checkbox"
                checked={Boolean(props.view.flags.viewed[path()])}
                onChange={(e) => props.cmd.setViewed(props.file, e.currentTarget.checked)}
              />
              Viewed
            </label>
          </>
        )}
      </Show>
    </div>
  );
}

/** What a file shows above or instead of its rows: details, why it's not shown, why it's collapsed. */
function Notice(props: { item: Extract<Item, { kind: "notice" }>; review: Review; cmd: Commands }) {
  const file = () => props.review.snapshot().files[props.item.file];
  return (
    <Card review={props.review} file={props.item.file}>
      {match(props.item.what)
        .with("details", () => (
          <div class="border-line border-b bg-panel px-3 py-1 text-xs text-muted">
            {file()?.details.join(" · ")}
          </div>
        ))
        .with("omitted", () => (
          <div class="bg-panel px-3 py-2 text-xs text-muted">{OMITTED[file()?.omitted ?? "binary"]}</div>
        ))
        .with("collapsed", () => (
          <div class="flex items-center gap-2 bg-panel px-3 py-1.5 text-xs text-muted">
            Collapsed: {file()?.collapsed}.
            <button
              type="button"
              class="cursor-pointer text-accent hover:underline"
              onClick={() => props.cmd.toggleFold(props.item.file)}
            >
              Show it
            </button>
          </div>
        ))
        .exhaustive()}
    </Card>
  );
}

/**
 * Folded lines between excerpts. Their rows aren't rendered: the page's own
 * search (`/`, and Ctrl+F) looks through them.
 */
function Gap(props: { item: Extract<Item, { kind: "gap" }>; review: Review; cmd: Commands }) {
  const file = () => props.review.snapshot().files[props.item.file];
  const n = () => props.item.end - props.item.start;
  const top = () => props.item.start === 0;
  const bottom = () => props.item.end === file()?.rows.length;
  /** The agent's summary, when the gap is (mostly) one of its folds. */
  const summary = () => {
    const model = props.review.models()[props.item.file];
    if (!model) return null;
    for (const r of props.review.regions()) {
      if (r.kind !== "fold" || !r.summary || r.path !== model.file.path) continue;
      if (regionRows(model, r).some((i) => i >= props.item.start && i < props.item.end)) return r.summary;
    }
    return null;
  };
  const expand = (dir: "down" | "up" | "all") =>
    props.cmd.expand(props.item.file, props.item.start, props.item.end, dir);
  const button = "cursor-pointer rounded px-1.5 text-[11.5px] font-medium text-accent hover:bg-accent-soft";
  return (
    <Card review={props.review} file={props.item.file} class="gap">
      <div class="flex h-5 items-center gap-0.5 border-y border-line bg-panel px-1.5 font-sans text-[11.5px] text-muted">
        <Show when={!top() && n() > 5}>
          <button
            type="button"
            class={button}
            title="Show more lines below the code above"
            onClick={() => expand("down")}
          >
            ↓ 5
          </button>
        </Show>
        <button type="button" class={button} onClick={() => expand("all")}>
          {n()} hidden line{n() === 1 ? "" : "s"}
        </button>
        <Show when={!bottom() && n() > 5}>
          <button
            type="button"
            class={button}
            title="Show more lines above the code below"
            onClick={() => expand("up")}
          >
            ↑ 5
          </button>
        </Show>
        <Show
          when={summary()}
          fallback={
            <span class="min-w-0 flex-1 truncate pl-1.5 font-mono text-[11px] text-subtle">
              {bottom()
                ? ""
                : (() => {
                    const f = file();
                    return f ? gapContext(f, props.item.end) : "";
                  })()}
            </span>
          }
        >
          {(s) => (
            <span
              class="min-w-0 flex-1 truncate pl-1.5 text-[11.5px] text-accent"
              title="Folded by the agent"
            >
              ✦ {s()}
            </span>
          )}
        </Show>
      </div>
    </Card>
  );
}

/** Thread cards under the row they end on, in the column of their side. */
function Threads(props: {
  item: Extract<Item, { kind: "threads" }>;
  review: Review;
  layout: LayoutState;
  cmd: Commands;
}) {
  const noteNumber = (t: Thread) => {
    const i = props.review.notes().indexOf(t);
    return i >= 0 ? i + 1 : undefined;
  };
  const f = () => props.review.snapshot().files[props.item.file];
  const solo = () => {
    const file = f();
    return file ? soloSide(file) : null;
  };
  return (
    <Card review={props.review} file={props.item.file}>
      <div
        class="grid grid-cols-[var(--cols)] border-y border-line bg-inset py-1"
        classList={{ solo: solo() !== null }}
      >
        <For each={props.layout.threadsAt(props.item.file, props.item.row)}>
          {(t) => (
            <div
              class="mr-2.5"
              classList={{
                "col-[2/3]": t.anchor.side === "old" || solo() !== null,
                "col-[4/5]": t.anchor.side === "new" && solo() === null,
              }}
            >
              <ThreadCard
                thread={t}
                review={props.review}
                cmd={props.cmd}
                {...(noteNumber(t) ? { noteNumber: noteNumber(t) as number } : {})}
              />
            </div>
          )}
        </For>
      </div>
    </Card>
  );
}

function Summary(props: { review: Review; cmd: Commands }) {
  return (
    <div class="rounded-md border border-accent-line bg-bg px-2.5 py-1.5 font-sans text-[12.5px] whitespace-normal">
      <Show when={props.review.meta().summary}>
        {(summary) => (
          <div class="flex gap-2">
            <b class="shrink-0 font-semibold text-accent">✦ Summary</b>
            <Markdown text={summary()} paths={props.review.paths()} class="max-w-[90ch]" />
          </div>
        )}
      </Show>
      <Show when={props.review.groups().length > 0}>
        <Contents review={props.review} cmd={props.cmd} />
      </Show>
      <Show when={props.review.notes().length > 0}>
        <button
          type="button"
          class="mt-1 cursor-pointer text-[11.5px] text-muted hover:text-fg"
          onClick={() => props.cmd.noteJump(1)}
        >
          Walk through {props.review.notes().length} note{props.review.notes().length === 1 ? "" : "s"}{" "}
          <kbd>]a</kbd>
        </button>
      </Show>
    </div>
  );
}
