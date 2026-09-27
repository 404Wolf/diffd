/**
 * Fenced code blocks in thread messages and chat (```rust … ```), highlighted
 * like the diff: by the server's tree-sitter grammars, with the same `s-*`
 * classes. A block of a language the server doesn't know stays plain.
 */
import * as api from "../api";
import { ok } from "./api";
import { Lru } from "./lru";
import { lineHtml } from "./render";

/** Highlighting runs per line, by language and code: the same block in many messages is asked for once. */
const cache = new Lru<string, Promise<readonly (readonly number[])[] | null>>(200);

function runsFor(language: string, code: string): Promise<readonly (readonly number[])[] | null> {
  const key = `${language}\n${code}`;
  let runs = cache.get(key);
  if (!runs) {
    runs = ok(api.highlight({ body: { language, code } }), "highlight code")
      .then((r) => r.lines)
      .catch(() => null);
    cache.set(key, runs);
  }
  return runs;
}

/** Highlight the fenced code blocks under `root` that name a language. */
export function highlightCodeBlocks(root: HTMLElement): void {
  for (const code of root.querySelectorAll<HTMLElement>("pre > code[class*='language-']")) {
    const language = [...code.classList].find((c) => c.startsWith("language-"))?.slice("language-".length);
    const text = code.textContent ?? "";
    if (!language || !text.trim()) continue;
    void runsFor(language, text).then((lines) => {
      // Rendered again meanwhile (a new message): leave the new block to its own call.
      if (!lines || !code.isConnected || code.textContent !== text) return;
      code.innerHTML = text
        .split("\n")
        .map((line, i) => lineHtml(line, lines[i], undefined, { novelClass: null }))
        .join("\n");
    });
  }
}
