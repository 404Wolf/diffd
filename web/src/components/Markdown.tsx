import { createMemo } from "solid-js";
import { renderMarkdown } from "../lib/markdown";

/** Sanitized Markdown; `path:line` references become links (handled by a delegated click). */
export function Markdown(props: { text: string; paths: readonly string[]; class?: string }) {
  const html = createMemo(() => renderMarkdown(props.text, props.paths));
  return <div class={`md ${props.class ?? ""}`} innerHTML={html()} />;
}
