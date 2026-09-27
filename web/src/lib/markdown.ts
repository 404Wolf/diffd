/**
 * Markdown for thread messages and chat. Raw HTML is off and the output is
 * sanitized: agent text is untrusted. `path:line` references to files in the
 * diff become links that jump there.
 */
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

// Links the agent writes open in a new tab, never in place of the review.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

export interface CodeLink {
  readonly file: number;
  readonly line: number;
}

/** Resolve `path:line` (full path or unique file name) against the diff's files. */
export function resolveRef(ref: string, paths: readonly string[]): CodeLink | null {
  const m = /^(.+?):(\d+)(?:-\d+)?$/.exec(ref);
  if (!m) return null;
  const [, path = "", line = "0"] = m;
  let file = paths.indexOf(path);
  if (file < 0) {
    const matches = paths.flatMap((p, i) => (p === path || p.endsWith(`/${path}`) ? [i] : []));
    if (matches.length !== 1) return null;
    file = matches[0] as number;
  }
  return { file, line: Number.parseInt(line, 10) };
}

/** `path/to/file.ext:12` or `:12-20`, with letters in any script. Paths with spaces work in `code`. */
const REF = /(?:[\p{L}\p{N}_.-]+\/)*[\p{L}\p{N}_.-]+\.[\p{L}\p{N}]+:\d+(?:-\d+)?/gu;

/** A link to `path:line` in the review; the page handles the click. */
function refLink(text: string, link: CodeLink, paths: readonly string[]): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = "#";
  // By path: file indexes change between revisions.
  a.dataset.go = `${paths[link.file]}:${link.line}`;
  a.textContent = text;
  return a;
}

/** Images would load from anywhere the agent names (a tracking pixel, say): links instead. */
function imagesToLinks(root: DocumentFragment) {
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    const label = img.getAttribute("alt") || src;
    if (!/^https?:/i.test(src)) {
      img.replaceWith(label);
      continue;
    }
    const a = document.createElement("a");
    a.href = src;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = `🖼 ${label}`;
    img.replaceWith(a);
  }
}

export function renderMarkdown(text: string, paths: readonly string[]): string {
  const html = DOMPurify.sanitize(md.render(text));
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  imagesToLinks(tpl.content);
  // A whole `code` span naming a place, spaces and all.
  for (const code of tpl.content.querySelectorAll("code")) {
    if (code.closest("pre, a")) continue;
    const text = code.textContent ?? "";
    const link = resolveRef(text, paths);
    if (link) code.replaceWith(refLink(text, link, paths));
  }
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    if (node.parentElement?.closest("a, pre")) continue;
    const value = node.nodeValue ?? "";
    let last = 0;
    const frag = document.createDocumentFragment();
    for (const m of value.matchAll(REF)) {
      const link = resolveRef(m[0], paths);
      if (!link) continue;
      frag.append(value.slice(last, m.index), refLink(m[0], link, paths));
      last = m.index + m[0].length;
    }
    if (last === 0) continue;
    frag.append(value.slice(last));
    node.replaceWith(frag);
  }
  return tpl.innerHTML;
}
