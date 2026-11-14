/**
 * Markdown documents on a Showing board (reports, plans, notes), as opposed
 * to the short Markdown of thread messages (`markdown.ts`). GitHub's rules:
 * a single line break is a space, tables and strikethrough work, and `- [x]`
 * items are checkboxes. Raw HTML is off and the output is sanitized: an
 * agent's document is untrusted.
 *
 * Images load only from the board itself: the ones diffd bundled with the
 * document when it was presented. Anything else (an image on the web, which
 * could be a tracking pixel, or a file that wasn't included) becomes a link
 * or a note. Links to the web open in a new tab; links to other local files
 * show as their text, since only this document was presented.
 */
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

/** Our own sanitizer, so hooks set up for thread messages don't apply here, and ours don't apply there. */
const purify = typeof window !== "undefined" ? DOMPurify(window) : null;

export interface DocumentContext {
  /** The images bundled with the document, by the path it names them with. */
  readonly assets: readonly string[];
  /** Where the page loads a bundled image from. */
  readonly assetUrl: (name: string) => string;
}

/** `%20` and friends, or the text as it is when it isn't valid. */
function decode(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/** The bundled image an `<img src>` means, if any. markdown-it percent-encodes what the document wrote. */
export function assetFor(src: string, assets: readonly string[]): string | null {
  const path = src.split(/[?#]/)[0] ?? "";
  for (const candidate of [src, path, decode(path)]) {
    if (assets.includes(candidate)) return candidate;
  }
  return null;
}

const WEB = /^https?:\/\//i;

function images(root: DocumentFragment, ctx: DocumentContext) {
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    const alt = img.getAttribute("alt") ?? "";
    const name = assetFor(src, ctx.assets);
    if (name !== null) {
      const url = ctx.assetUrl(name);
      img.setAttribute("src", url);
      img.setAttribute("loading", "lazy");
      img.setAttribute("decoding", "async");
      // A tap opens it on its own, where the phone can zoom.
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "doc-image";
      img.replaceWith(a);
      a.append(img);
      continue;
    }
    if (WEB.test(src)) {
      const a = document.createElement("a");
      a.href = src;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = `🖼 ${alt || src}`;
      img.replaceWith(a);
      continue;
    }
    const note = document.createElement("span");
    note.className = "doc-missing";
    note.textContent = `🖼 ${alt || src} · not included`;
    note.title = src;
    img.replaceWith(note);
  }
}

function links(root: DocumentFragment) {
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    if (a.classList.contains("doc-image")) continue;
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) continue;
    if (WEB.test(href) || /^mailto:/i.test(href)) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      continue;
    }
    // Another local file: not on the board, so there's nothing to open.
    const span = document.createElement("span");
    span.className = "doc-path";
    span.title = `${decode(href)} (not included with this document)`;
    span.append(...a.childNodes);
    a.replaceWith(span);
  }
}

/** Tables scroll sideways in their own box instead of squeezing their columns (or widening the page). */
function tables(root: DocumentFragment) {
  for (const table of root.querySelectorAll("table")) {
    const box = document.createElement("div");
    box.className = "doc-table";
    box.tabIndex = 0;
    box.setAttribute("role", "region");
    box.setAttribute("aria-label", "Table");
    table.replaceWith(box);
    box.append(table);
  }
}

const TASK = /^\[([ xX])\]\s+/;

/** `- [ ] todo` and `- [x] done` as (read-only) checkboxes. */
function taskLists(root: DocumentFragment) {
  for (const li of root.querySelectorAll("li")) {
    // Tight lists put the text right in the item; loose ones wrap it in a paragraph.
    const holder = li.firstElementChild?.tagName === "P" && !li.firstChild?.nodeValue?.trim() ? li.firstElementChild : li;
    const first = holder.firstChild;
    if (!first || first.nodeType !== Node.TEXT_NODE) continue;
    const m = TASK.exec(first.nodeValue ?? "");
    if (!m) continue;
    first.nodeValue = (first.nodeValue ?? "").slice(m[0].length);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.disabled = true;
    box.checked = m[1] !== " ";
    box.setAttribute("aria-label", box.checked ? "Done" : "Not done");
    holder.prepend(box, " ");
    li.classList.add("task");
    li.parentElement?.classList.add("tasks");
  }
}

/** A document as sanitized HTML, ready for `innerHTML`. Fenced code is highlighted afterwards (`codeBlocks.ts`). */
export function renderDocument(text: string, ctx: DocumentContext): string {
  const raw = md.render(text);
  const html = purify ? purify.sanitize(raw) : "";
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  images(tpl.content, ctx);
  links(tpl.content);
  tables(tpl.content);
  taskLists(tpl.content);
  return tpl.innerHTML;
}
