import { describe, expect, it } from "vitest";
import type { BoardItem } from "../api";
import {
  assetUrl,
  boardPath,
  codeRowsHtml,
  isNew,
  neighbour,
  openFromLocation,
  presenter,
  trayOrder,
} from "./board";
import { assetFor, renderDocument } from "./document";

const item = (over: Partial<BoardItem> = {}): BoardItem => ({
  id: "s1",
  scope: "herdr-android",
  kind: "markdown",
  title: "Plan",
  message: null,
  lines: null,
  language: null,
  source: { path: "/r/plan.md", machine: "server", terminal: "t1n7", agent: "Claude", role: "worker", project: "x" },
  revision: 1,
  state: "open",
  seenRevision: 0,
  assets: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const ctx = (assets: string[] = []) => ({ assets, assetUrl: (name: string) => `/asset?name=${name}` });

const dom = (html: string): HTMLElement => {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
};

describe("documents", () => {
  it("renders GitHub-style Markdown: tables in a scrolling box, soft breaks as spaces, strikethrough", () => {
    const el = dom(renderDocument("# Plan\none\ntwo ~~old~~\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n", ctx()));
    expect(el.querySelector("h1")?.textContent).toBe("Plan");
    expect(el.querySelector("p")?.innerHTML).toBe("one\ntwo <s>old</s>");
    const box = el.querySelector(".doc-table");
    expect(box?.getAttribute("role")).toBe("region");
    expect(box?.querySelector("table td:last-child")?.getAttribute("style")).toContain("right");
  });

  it("sanitizes: no raw HTML, no script links, no event handlers", () => {
    const el = dom(
      renderDocument(
        '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[click](javascript:alert(1)) <b onclick="x">b</b>',
        ctx(),
      ),
    );
    expect(el.querySelector("script, b, [onerror], [onclick]")).toBeNull();
    expect(el.querySelector('a[href^="javascript"]')).toBeNull();
    expect(el.textContent).toContain("<script>");
  });

  it("loads only the images bundled with the document", () => {
    const el = dom(
      renderDocument(
        "![cover](shots/cover.png) ![space](<shots/with space.png>) ![web](https://example.com/p.png) ![gone](gone.png)",
        ctx(["shots/cover.png", "shots/with space.png"]),
      ),
    );
    const srcs = [...el.querySelectorAll("img")].map((i) => i.getAttribute("src"));
    expect(srcs).toEqual(["/asset?name=shots/cover.png", "/asset?name=shots/with space.png"]);
    expect(el.querySelector("a.doc-image")?.getAttribute("target")).toBe("_blank");
    const web = [...el.querySelectorAll("a")].find((a) => a.textContent?.includes("web"));
    expect(web?.getAttribute("href")).toBe("https://example.com/p.png");
    expect(el.querySelector(".doc-missing")?.textContent).toBe("🖼 gone · not included");
    expect(assetFor("a%20b.png?raw=1", ["a b.png"])).toBe("a b.png");
    expect(assetFor("other.png", ["a b.png"])).toBeNull();
  });

  it("opens web links in a new tab and shows links to other local files as text", () => {
    const el = dom(renderDocument("[site](https://example.com) [plan](PLAN.md) [top](#top) www.example.org", ctx()));
    const links = [...el.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com", "#top", "http://www.example.org"]);
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(el.querySelector(".doc-path")?.textContent).toBe("plan");
    expect(el.querySelector(".doc-path")?.getAttribute("title")).toContain("PLAN.md");
  });

  it("turns task list items into read-only checkboxes, tight or loose", () => {
    const tight = dom(renderDocument("- [x] done\n- [ ] todo\n- plain", ctx()));
    const boxes = [...tight.querySelectorAll<HTMLInputElement>("li input[type=checkbox]")];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(tight.querySelector("ul")?.classList.contains("tasks")).toBe(true);
    expect(tight.querySelectorAll("li")[0]?.textContent?.trim()).toBe("done");
    const loose = dom(renderDocument("- [x] done\n\n- [ ] todo\n", ctx()));
    expect(loose.querySelectorAll("li p input").length).toBe(2);
  });
});

describe("the board", () => {
  it("orders the tray: open, then minimised; hidden apart", () => {
    const items = [
      item({ id: "a", state: "minimised" }),
      item({ id: "b", state: "hidden" }),
      item({ id: "c", state: "open" }),
    ];
    const { shown, hidden } = trayOrder(items);
    expect(shown.map((i) => i.id)).toEqual(["c", "a"]);
    expect(hidden.map((i) => i.id)).toEqual(["b"]);
  });

  it("knows what's new and steps between items", () => {
    expect(isNew(item({ revision: 2, seenRevision: 1 }))).toBe(true);
    expect(isNew(item({ revision: 2, seenRevision: 2 }))).toBe(false);
    const items = [item({ id: "a" }), item({ id: "b" })];
    expect(neighbour(items, "a", 1)?.id).toBe("b");
    expect(neighbour(items, "b", 1)?.id).toBe("a");
    expect(neighbour(items, null, -1)?.id).toBe("b");
    expect(neighbour([], null, 1)).toBeUndefined();
  });

  it("builds and reads its addresses", () => {
    expect(boardPath("herdr-android", "s-1")).toBe("/show/herdr-android/s-1");
    expect(boardPath("herdr-android", null)).toBe("/show/herdr-android");
    expect(boardPath(null, "s-1")).toBe("/show?open=s-1");
    expect(boardPath(null, null)).toBe("/show");
    expect(openFromLocation({ pathname: "/show/herdr-android/s-1", search: "" })).toBe("s-1");
    expect(openFromLocation({ pathname: "/show", search: "?open=s-2" })).toBe("s-2");
    expect(openFromLocation({ pathname: "/show/herdr-android", search: "" })).toBeNull();
    expect(assetUrl({ id: "s 1", revision: 3 }, "shots/a b.png")).toBe(
      "/api/board/s%201/asset?name=shots%2Fa+b.png&rev=3",
    );
    expect(presenter(item())).toBe("t1n7 · worker · server");
  });

  it("renders code rows with line numbers, lit lines and diff colours", () => {
    const rows = dom(codeRowsHtml("a\n<b>\nc\n", [[], [], []], { language: null, lit: [2, 3] }));
    const lines = [...rows.querySelectorAll(".cl")];
    expect(lines.length).toBe(3);
    expect(lines.map((l) => l.classList.contains("lit"))).toEqual([false, true, true]);
    expect(lines[1]?.querySelector(".ct")?.textContent).toBe("<b>");
    expect(lines[1]?.querySelector(".ln")?.textContent).toBe("2");
    const diff = dom(codeRowsHtml("--- a\n@@ -1 +1 @@\n-old\n+new\n same", [], { language: "Diff", lit: null }));
    expect([...diff.querySelectorAll(".cl")].map((l) => l.className)).toEqual([
      "cl d-file",
      "cl d-hunk",
      "cl d-del",
      "cl d-add",
      "cl",
    ]);
  });
});
