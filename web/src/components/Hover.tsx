import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { match } from "ts-pattern";
import type { Diagnostic } from "../api";
import { columnAtPoint, diagnosticSpan, diagnosticsOn, rank, textRange, wordAt } from "../lib/code";
import { allBuffers, rowEl, rowsRenderedEvent } from "../state/dom";
import type { Review } from "../state/review";
import type { View } from "../state/view";
import { Markdown } from "./Markdown";

const SEVERITY_CLASS: Record<Diagnostic["severity"], string> = {
  error: "text-del",
  warning: "text-warn",
  info: "text-accent",
  hint: "text-muted",
};

/** A language server's docs and the diagnostics at a spot, floating by the word. */
export function HoverCard(props: { review: Review; view: View }) {
  let el: HTMLDivElement | undefined;
  const [pos, setPos] = createSignal({ left: 0, top: 0 });
  createEffect(() => {
    const h = props.view.hover();
    if (!h) return;
    queueMicrotask(() => {
      if (!el) return;
      const w = el.offsetWidth;
      const hgt = el.offsetHeight;
      const below = h.at.bottom + 4;
      const top = below + hgt > window.innerHeight - 8 ? Math.max(8, h.at.top - hgt - 4) : below;
      setPos({ left: Math.max(8, Math.min(window.innerWidth - w - 8, h.at.left)), top });
    });
  });
  onMount(() => {
    const close = () => props.view.setHover(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Shift" && e.key !== "Control" && e.key !== "Meta") close();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", close, true);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", close, true);
    });
  });
  return (
    <Show when={props.view.hover()}>
      {(h) => (
        <div
          ref={el}
          role="tooltip"
          data-hover
          class="fixed z-30 max-h-[320px] w-max max-w-[min(560px,calc(100vw-16px))] overflow-auto rounded-md border border-line-strong bg-bg text-[12.5px] shadow-pop"
          style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
          onMouseLeave={() => props.view.setHover(null)}
        >
          <For each={h().diagnostics}>
            {(d) => (
              <div class="flex gap-2 border-b border-line px-2.5 py-1.5 last:border-b-0">
                <span
                  class={`font-semibold uppercase text-[10px] tracking-wider ${SEVERITY_CLASS[d.severity]}`}
                >
                  {d.severity}
                </span>
                <span class="min-w-0 whitespace-pre-wrap">
                  {d.message}
                  <Show when={d.source}>{(s) => <span class="text-subtle"> · {s()}</span>}</Show>
                </span>
              </div>
            )}
          </For>
          <Show when={h().markdown}>
            {(md) => <Markdown text={md()} paths={props.review.paths()} class="md-hover px-2.5 py-1.5" />}
          </Show>
        </div>
      )}
    </Show>
  );
}

/** Wait this long on a word before asking about it. */
const HOVER_DELAY_MS = 350;

/**
 * Hovering code with the mouse shows docs (from a language server) and the
 * diagnostics there, like an editor. Only on the new side of working-tree reviews.
 */
export function useMouseHover(props: { review: Review; view: View }, buffer: () => HTMLElement | undefined) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let asked = "";
  const onMove = (e: MouseEvent) => {
    clearTimeout(timer);
    const target = e.target as HTMLElement;
    if (target.closest("[data-hover]")) return;
    const code = target.closest<HTMLElement>('.code[data-side="new"]');
    const row = code?.closest<HTMLElement>(".row");
    if (!code || !row || e.buttons !== 0) return;
    const { clientX: x, clientY: y } = e;
    timer = setTimeout(() => void show(code, row, x, y), HOVER_DELAY_MS);
  };
  const show = async (code: HTMLElement, row: HTMLElement, x: number, y: number) => {
    const file = props.review.snapshot().files[Number(row.dataset.f)];
    const line = Number(row.dataset.nl);
    const col = columnAtPoint(code, x, y);
    if (!file || !line || col === null) return;
    const text = file.new?.lines[line - 1] ?? "";
    const word = wordAt(text, col);
    const diagnostics = diagnosticsOn(props.review.conv.diagnostics[file.path], line).filter((d) => {
      const span = diagnosticSpan(d, line, text.length);
      return span !== null && col >= span[0] && col < span[1];
    });
    if (!word && diagnostics.length === 0) return;
    const key = `${file.path}:${line}:${word?.col ?? col}`;
    if (key === asked && props.view.hover()?.key === key) return;
    asked = key;
    const canAsk = word && props.review.meta().to === null && (props.review.range()?.to ?? null) === null;
    const answer = canAsk ? await props.review.ask("hover", file.path, line, word.col) : null;
    if (asked !== key) return;
    const markdown = answer?.type === "hover" ? answer.markdown : null;
    if (!markdown && diagnostics.length === 0) return;
    const box = (word
      ? textRange(code, word.col, word.col + word.text.length)
      : null
    )?.getBoundingClientRect() ?? {
      left: x,
      top: y - 9,
      bottom: y + 9,
    };
    props.view.setHover({
      key,
      markdown,
      diagnostics,
      at: { left: box.left, top: box.top, bottom: box.bottom },
    });
  };
  onMount(() => {
    const buf = buffer();
    buf?.addEventListener("mousemove", onMove);
    const leave = () => {
      clearTimeout(timer);
      asked = "";
    };
    buf?.addEventListener("mouseleave", leave);
    onCleanup(() => {
      clearTimeout(timer);
      buf?.removeEventListener("mousemove", onMove);
      buf?.removeEventListener("mouseleave", leave);
    });
  });
}

const HIGHLIGHTS = ["diag-error", "diag-warning", "diag-info"] as const;
type HighlightName = (typeof HIGHLIGHTS)[number];
const highlightFor = (s: Diagnostic["severity"]): HighlightName =>
  match(s)
    .with("error", () => "diag-error" as const)
    .with("warning", () => "diag-warning" as const)
    .with("info", "hint", () => "diag-info" as const)
    .exhaustive();

/**
 * Paint diagnostics onto the static rows of every split: wavy underlines via
 * the CSS Custom Highlight API (no DOM changes to the code), and a mark in the
 * line-number gutter.
 */
export function usePaintDiagnostics(props: { review: Review; view: View }) {
  let marked: HTMLElement[] = [];
  const GUTTER = ["diag-error", "diag-warning", "diag-info"];
  let frame = 0;
  const paint = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      for (const el of marked) el.classList.remove(...GUTTER);
      marked = [];
      /** The worst diagnostic on each gutter cell. */
      const worst = new Map<HTMLElement, Diagnostic["severity"]>();
      const ranges: Record<HighlightName, Range[]> = {
        "diag-error": [],
        "diag-warning": [],
        "diag-info": [],
      };
      const files = props.review.snapshot().files;
      const models = props.review.models();
      for (const [path, diagnostics] of Object.entries(props.review.conv.diagnostics)) {
        const file = files.findIndex((f) => f.path === path);
        const model = models[file];
        const text = files[file]?.new;
        if (!diagnostics?.length || !model || !text) continue;
        for (const buf of allBuffers()) {
          for (const d of diagnostics) {
            for (let line = d.line; line <= d.endLine; line++) {
              const r = model.newRow[line - 1];
              const row = r === undefined ? null : rowEl(file, r, buf);
              const code = row?.querySelector<HTMLElement>('.code[data-side="new"]');
              const span = code ? diagnosticSpan(d, line, text.lines[line - 1]?.length ?? 0) : null;
              if (!code || !span) continue;
              const range = textRange(code, span[0], span[1]);
              if (range) ranges[highlightFor(d.severity)].push(range);
              const num = row?.querySelector<HTMLElement>('.num[data-side="new"]');
              const was = num ? worst.get(num) : undefined;
              if (num && (was === undefined || rank(d.severity) < rank(was))) worst.set(num, d.severity);
            }
          }
        }
      }
      for (const [num, severity] of worst) {
        num.classList.add(highlightFor(severity));
        marked.push(num);
      }
      const registry = (globalThis.CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
      const HighlightCtor = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown })
        .Highlight;
      if (registry && HighlightCtor)
        for (const name of HIGHLIGHTS) registry.set(name, new HighlightCtor(...ranges[name]));
    });
  };
  createEffect(() => {
    // Anything that re-renders rows or moves diagnostics.
    props.review.conv.diagnostics;
    for (const d of Object.values(props.review.conv.diagnostics)) d?.length;
    props.review.snapshot();
    props.review.threads().length;
    props.view.panes();
    for (const p of props.view.panes()) p.mode();
    for (let i = 0; i < props.review.snapshot().files.length; i++) props.view.visible(i);
    paint();
  });
  onMount(() => {
    document.addEventListener(rowsRenderedEvent, paint);
    onCleanup(() => document.removeEventListener(rowsRenderedEvent, paint));
  });
}
