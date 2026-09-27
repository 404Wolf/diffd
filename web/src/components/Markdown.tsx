import { createEffect, createMemo } from "solid-js";
import { highlightCodeBlocks } from "../lib/codeBlocks";
import { renderMarkdown } from "../lib/markdown";

/**
 * Sanitized Markdown; `path:line` references become links (handled by a
 * delegated click), and fenced code is highlighted like the diff.
 */
export function Markdown(props: { text: string; paths: readonly string[]; class?: string }) {
  let el: HTMLDivElement | undefined;
  const html = createMemo(() => renderMarkdown(props.text, props.paths));
  createEffect(() => {
    html();
    if (el) highlightCodeBlocks(el);
  });
  return <div ref={el} class={`md ${props.class ?? ""}`} innerHTML={html()} />;
}
