import { createMemo, createRenderEffect, For, Match, Show, Switch } from "solid-js";
import type { FileDiff } from "../gen/FileDiff";
import type { Thread } from "../gen/Thread";
import { type Block, blocks, gapContext, regionRows, rowOf } from "../lib/diffModel";
import { lazyChunks, placeholderHtml } from "../lib/lazyRows";
import { escapeHtml, type RowMarks, rowHtml } from "../lib/render";
import type { Commands } from "../state/commands";
import type { Review } from "../state/review";
import type { View } from "../state/view";
import { ThreadCard } from "./ThreadCard";

/** Hidden regions bigger than this aren't pre-rendered (and so aren't searchable with Ctrl+F). */
const MAX_HIDDEN_ROWS = 4000;

interface Props {
  index: number;
  review: Review;
  view: View;
  cmd: Commands;
}

const STATUS_LETTER = { added: "A", deleted: "D", modified: "M", renamed: "R" } as const;
const STATUS_COLOR = {
  added: "text-add",
  deleted: "text-del",
  modified: "text-warn",
  renamed: "text-accent",
} as const;

/** Rows per lazily laid-out chunk in long runs of rows. */
const CHUNK_ROWS = 80;

export function FileSection(props: Props) {
  const file = (): FileDiff => props.review.snapshot().files[props.index] as FileDiff;
  const model = () => props.review.models()[props.index];
  const dir = () => (file().path.includes("/") ? file().path.slice(0, file().path.lastIndexOf("/") + 1) : "");
  const name = () => file().path.slice(dir().length);

  /** Threads ending at each row, where they're shown. */
  const threadsByRow = createMemo(() => {
    const byRow = new Map<number, Thread[]>();
    const m = model();
    if (!m) return byRow;
    for (const t of props.review.threads()) {
      if (t.anchor.path !== file().path) continue;
      const row = rowOf(m, t.anchor.side, t.anchor.end);
      if (row < 0) continue;
      byRow.set(row, [...(byRow.get(row) ?? []), t]);
    }
    return byRow;
  });

  const regions = createMemo(() => props.review.regions().filter((r) => r.path === file().path));
  const testRows = createMemo(() => {
    const m = model();
    const rows = new Set<number>();
    if (m) for (const r of regions()) if (r.kind === "test") for (const i of regionRows(m, r)) rows.add(i);
    return rows;
  });
  const wholeFileTest = () => regions().some((r) => r.kind === "test" && r.lines === null);
  /** The agent's summary for a folded gap, when the gap is (mostly) one of its folds. */
  const foldSummary = (start: number, end: number): string | null => {
    const m = model();
    if (!m) return null;
    for (const r of regions()) {
      if (r.kind !== "fold" || !r.summary) continue;
      const rows = regionRows(m, r);
      if (rows.some((i) => i >= start && i < end)) return r.summary;
    }
    return null;
  };

  const marks = createMemo<RowMarks>(() => {
    const noted = new Set<number>();
    for (const t of props.review.notes()) {
      if (t.anchor.path === file().path && t.anchor.side === "new")
        for (let l = t.anchor.start; l <= t.anchor.end; l++) noted.add(l);
    }
    const named = new Map<string, string>();
    for (const [name, m] of Object.entries(props.view.marks))
      if (m.path === file().path) named.set(`${m.side}:${m.line}`, name);
    return {
      noted,
      since: new Set(file().since),
      refs: props.review.definedNames(),
      tests: testRows(),
      named,
    };
  });

  // Keep block identities stable across recomputation, so only changed blocks re-render.
  let cache = new Map<string, Block>();
  const layout = createMemo(() => {
    const next = new Map<string, Block>();
    const list = blocks(props.view.visible(props.index), new Set(threadsByRow().keys())).map((b) => {
      const key = b.kind === "after" ? `after:${b.row}` : `${b.kind}:${b.start}:${b.end}`;
      const kept = cache.get(key) ?? b;
      next.set(key, kept);
      return kept;
    });
    cache = next;
    return list;
  });

  /** Rows as HTML; long runs are split into chunks the browser lays out only near the viewport. */
  const rows = (start: number, end: number) => {
    let html = "";
    const f = file();
    // Placeholders fill in later, outside this effect: track the marks here so changes re-render them.
    marks();
    const chunked = end - start > CHUNK_ROWS;
    for (let c = start; c < end; c += CHUNK_ROWS) {
      const stop = Math.min(end, c + CHUNK_ROWS);
      // The first chunk is real right away, so the cursor has somewhere to land.
      if (chunked && c > start) {
        html += placeholderHtml(c, stop, plainRows(f, c, stop));
        continue;
      }
      if (chunked) html += `<div class="chunk" style="--n:${stop - c}">`;
      html += realRows(c, stop);
      if (chunked) html += "</div>";
    }
    return html;
  };
  const realRows = (start: number, end: number) => {
    let html = "";
    const f = file();
    const m = marks();
    for (let r = start; r < end; r++) html += rowHtml(props.index, r, f, m);
    return html;
  };
  /** Put rows into `el`, and have its placeholders filled in as they come near the screen. */
  const setRows = (el: HTMLElement, html: string) => {
    el.innerHTML = html;
    lazyChunks(el, (chunk) => () => realRows(Number(chunk.dataset.a), Number(chunk.dataset.b)));
  };

  const noteNumber = (t: Thread) => {
    const i = props.review.notes().indexOf(t);
    return i >= 0 ? i + 1 : undefined;
  };

  return (
    <section
      id={`file-${props.index}`}
      data-file-section={props.index}
      class="mx-2.5 my-2 overflow-clip rounded-md border border-line-strong bg-bg"
    >
      <div
        data-file-head
        class="sticky top-0 z-[3] flex h-[30px] items-center gap-2 border-line bg-panel px-2 text-xs"
        classList={{ "border-b": !props.view.hidden(props.index) }}
      >
        <button
          type="button"
          class="size-[18px] cursor-pointer rounded text-[9px] text-subtle hover:bg-hover hover:text-fg"
          classList={{ "-rotate-90": props.view.hidden(props.index) }}
          aria-label={props.view.hidden(props.index) ? `Expand ${file().path}` : `Collapse ${file().path}`}
          onClick={() => props.cmd.toggleFold(props.index)}
        >
          ▼
        </button>
        <span class={`w-3 text-center font-mono text-[10px] font-semibold ${STATUS_COLOR[file().status]}`}>
          {STATUS_LETTER[file().status]}
        </span>
        <span
          class="min-w-0 flex-1 truncate font-mono text-xs font-medium"
          title={file().path}
          data-path={file().path}
        >
          <Show when={file().oldPath}>{(old) => <span class="text-muted">{old()} → </span>}</Show>
          <span class="font-normal text-muted">{dir()}</span>
          {name()}
        </span>
        <Show when={file().collapsed}>
          {(reason) => (
            <span
              class="rounded bg-accent-soft px-1.5 text-[11px] text-accent"
              title="Collapsed when the review was shared"
            >
              ✦ {reason()}
            </span>
          )}
        </Show>
        <Show when={testRows().size > 0}>
          <span
            class="rounded bg-[color-mix(in_srgb,var(--test)_14%,transparent)] px-1.5 text-[11px] text-[var(--test)]"
            title="Marked as tests by the agent"
          >
            {wholeFileTest() ? "test file" : "has tests"}
          </span>
        </Show>
        <Show when={file().language}>
          {(lang) => <span class="rounded bg-inset px-1.5 text-[11px] text-muted">{lang()}</span>}
        </Show>
        <span class="flex gap-1.5 font-mono text-[11.5px] tabular-nums">
          <span class="text-add">+{file().added}</span>
          <span class="text-del">−{file().removed}</span>
        </span>
        <label class="inline-flex cursor-pointer items-center gap-1 text-[11.5px] text-muted">
          <input
            type="checkbox"
            checked={Boolean(props.view.flags.viewed[file().path])}
            onChange={(e) => props.cmd.setViewed(props.index, e.currentTarget.checked)}
          />
          Viewed
        </label>
      </div>
      <Show
        when={!props.view.hidden(props.index)}
        fallback={
          <Show when={file().collapsed && !props.view.flags.viewed[file().path]}>
            <div class="flex items-center gap-2 bg-panel px-3 py-1.5 text-xs text-muted">
              Collapsed: {file().collapsed}.
              <button
                type="button"
                class="cursor-pointer text-accent hover:underline"
                onClick={() => props.cmd.toggleFold(props.index)}
              >
                Show it
              </button>
            </div>
          </Show>
        }
      >
        <Show
          when={!file().binary}
          fallback={
            <div class="bg-panel px-3 py-2 text-xs text-muted">Binary or very large file, not shown.</div>
          }
        >
          <div class="rows">
            <For each={layout()}>
              {(b) => (
                <Switch>
                  <Match when={b.kind === "rows" && b}>
                    {(r) => {
                      const el = (<div />) as HTMLDivElement;
                      createRenderEffect(() => setRows(el, rows(r().start, r().end)));
                      return el;
                    }}
                  </Match>
                  <Match when={b.kind === "gap" && b}>
                    {(g) => (
                      <Gap
                        file={file()}
                        start={g().start}
                        end={g().end}
                        html={g().end - g().start <= MAX_HIDDEN_ROWS ? () => rows(g().start, g().end) : null}
                        setRows={setRows}
                        summary={foldSummary(g().start, g().end)}
                        onExpand={(dir) => props.cmd.expand(props.index, g().start, g().end, dir)}
                      />
                    )}
                  </Match>
                  <Match when={b.kind === "after" && b}>
                    {(a) => (
                      <div class="grid grid-cols-[var(--cols)] border-y border-line bg-inset py-1.5">
                        <For each={threadsByRow().get(a().row) ?? []}>
                          {(t) => (
                            <div
                              class="mr-2.5"
                              classList={{
                                "col-[2/3]": t.anchor.side === "old",
                                "col-[4/5]": t.anchor.side === "new",
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
                    )}
                  </Match>
                </Switch>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </section>
  );
}

/**
 * Folded lines between excerpts. The folded rows stay in the DOM as
 * `hidden="until-found"`, so the browser's Ctrl+F finds them and unfolds them.
 */
function Gap(props: {
  file: FileDiff;
  start: number;
  end: number;
  html: (() => string) | null;
  /** The agent folded this region; what changed in it. */
  summary: string | null;
  onExpand: (dir: "down" | "up" | "all") => void;
  setRows: (el: HTMLElement, html: string) => void;
}) {
  const n = () => props.end - props.start;
  const top = () => props.start === 0;
  const bottom = () => props.end === props.file.rows.length;

  const button = "cursor-pointer rounded px-1.5 text-[11.5px] font-medium text-accent hover:bg-accent-soft";
  return (
    <>
      <div class="flex h-[22px] items-center gap-0.5 border-y border-line bg-panel px-1.5 font-sans text-[11.5px] text-muted">
        <Show when={!top() && n() > 5}>
          <button
            type="button"
            class={button}
            title="Show more lines below the code above"
            onClick={() => props.onExpand("down")}
          >
            ↓ 5
          </button>
        </Show>
        <button type="button" class={button} onClick={() => props.onExpand("all")}>
          {n()} hidden line{n() === 1 ? "" : "s"}
        </button>
        <Show when={!bottom() && n() > 5}>
          <button
            type="button"
            class={button}
            title="Show more lines above the code below"
            onClick={() => props.onExpand("up")}
          >
            ↑ 5
          </button>
        </Show>
        <Show
          when={props.summary}
          fallback={
            <span class="min-w-0 flex-1 truncate pl-1.5 font-mono text-[11px] text-subtle">
              {bottom() ? "" : gapContext(props.file, props.end)}
            </span>
          }
        >
          {(summary) => (
            <span
              class="min-w-0 flex-1 truncate pl-1.5 text-[11.5px] text-accent"
              title="Folded by the agent"
            >
              ✦ {summary()}
            </span>
          )}
        </Show>
      </div>
      <Show when={props.html}>
        {(html) => {
          const el = (<div class="gap-body" />) as HTMLDivElement;
          // Hidden from the start (not on mount), so nothing measures the page with it open.
          el.setAttribute("hidden", "until-found");
          el.addEventListener("beforematch", () => props.onExpand("all"));
          createRenderEffect(() => props.setRows(el, html()()));
          return el;
        }}
      </Show>
    </>
  );
}

/** Rows as plain text, one line each (old side, then new), for placeholders. */
function plainRows(f: FileDiff, start: number, end: number): string {
  let out = "";
  for (let r = start; r < end; r++) {
    const row = f.rows[r];
    if (!row) continue;
    const old = row[0] === null ? "" : (f.old?.lines[row[0]] ?? "");
    const neu = row[1] === null ? "" : (f.new?.lines[row[1]] ?? "");
    out += `${escapeHtml(old)}\t${escapeHtml(neu)}\n`;
  }
  return out;
}
