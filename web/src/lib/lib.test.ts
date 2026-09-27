import { describe, expect, it } from "vitest";
import type { FileDiff } from "../gen/FileDiff";
import { blocks, expandGap, fileModel, initialVisible, nearestGap } from "./diffModel";
import { carrySpan, locate, points, rangeOf, spanLabel, step, steps } from "./history";
import { JumpList } from "./jumps";
import { KeyEngine, keyToken } from "./keymap";
import { renderMarkdown, resolveRef } from "./markdown";
import { changeMarks, lineHtml, rowHtml } from "./render";
import { buildTree, parentDir, treeOrder } from "./tree";

const file = (): FileDiff => ({
  path: "src/a.rs",
  oldPath: null,
  status: "modified",
  language: "Rust",
  binary: false,
  collapsed: null,
  added: 2,
  removed: 1,
  old: { lines: ["a", "let x = 1;", "c"], syntax: [[], [0, 3, 0], []], novel: [[], [8, 9], []] },
  new: {
    lines: ["a", "let x = 2;", "new", "c"],
    syntax: [[], [0, 3, 0], [], []],
    novel: [[], [8, 9], [0, 3], []],
  },
  rows: [
    [0, 0],
    [1, 1],
    [null, 2],
    [2, 3],
  ],
  since: [],
});

describe("lineHtml", () => {
  it("merges syntax, novelty and escaping", () => {
    expect(lineHtml("let x = <1>;", [0, 3, 0], [9, 10], { novelClass: "nv-add" })).toBe(
      '<span class="s-keyword">let</span> x = &lt;<span class="nv-add">1</span>&gt;;',
    );
  });
  it("marks refs and the word cursor", () => {
    const html = lineHtml("foo(bar)", undefined, undefined, {
      novelClass: null,
      refs: new Set(["bar"]),
      word: [0, 3],
    });
    expect(html).toBe('<span class="wc">foo</span>(<span class="ref">bar</span>)');
  });
  it("never colors whitespace-only segments", () => {
    expect(lineHtml("a  b", [0, 1, 0], [0, 4], { novelClass: "nv-add" })).toBe(
      '<span class="s-keyword nv-add">a</span><span class="nv-add">  b</span>',
    );
    expect(lineHtml("x   ", [0, 1, 0], [1, 4], { novelClass: "nv-add" })).toBe(
      '<span class="s-keyword">x</span>   ',
    );
  });
});

describe("rows", () => {
  it("renders an aligned row with numbers and change colors", () => {
    const html = rowHtml(0, 1, file(), {
      noted: new Set([2]),
      since: new Set(),
      refs: new Set(),
      tests: new Set([1]),
    });
    expect(html).toContain(
      '<div class="row test" data-f="0" data-r="1" data-ol="2" data-nl="2" data-chg="1"',
    );
    expect(html).toContain('class="num old del" data-n="2"');
    expect(html).toContain('class="num new add noted" data-n="2"');
  });
  it("marks changes for file view", () => {
    expect(changeMarks(file(), "new")).toEqual(["", "mod", "add", ""]);
  });
});

describe("excerpts", () => {
  it("shows changes with context and folds the rest", () => {
    const model = fileModel({
      ...file(),
      rows: Array.from({ length: 20 }, (_, i) => [i, i] as [number, number]),
    });
    expect(model.hunks).toEqual([1]);
    const vis = initialVisible(model, 2);
    // Rows 1 and 2 change; two lines of context either side.
    expect(blocks(vis, new Set())).toEqual([
      { kind: "rows", start: 0, end: 5 },
      { kind: "gap", start: 5, end: 20 },
    ]);
    expect(blocks(vis, new Set([1]))).toEqual([
      { kind: "rows", start: 0, end: 2 },
      { kind: "after", row: 1 },
      { kind: "rows", start: 2, end: 5 },
      { kind: "gap", start: 5, end: 20 },
    ]);
    const grown = expandGap(vis, 5, 20, "down", 5);
    expect(blocks(grown, new Set())[1]).toEqual({ kind: "gap", start: 10, end: 20 });
  });
  it("finds the nearest gap toward the cursor", () => {
    const vis = Uint8Array.from([0, 0, 1, 1, 1, 1, 1, 0, 0, 0]);
    expect(nearestGap(vis, 3)).toEqual({ start: 0, end: 2, dir: "up" });
    expect(nearestGap(vis, 5)).toEqual({ start: 7, end: 10, dir: "down" });
  });
});

describe("keymap", () => {
  const run = () =>
    new KeyEngine<string[]>([
      { keys: "j", run: (l, n) => l.push(`j${n}`) },
      { keys: "g d", run: (l) => l.push("gd") },
      { keys: "g c c", run: (l) => l.push("gcc") },
      { keys: "g c", modes: ["visual"], run: (l) => l.push("gc") },
      { keys: "enter", modes: ["symbol"], run: (l) => l.push("def") },
    ]);
  it("handles counts and sequences", () => {
    const log: string[] = [];
    const e = run();
    for (const k of ["5", "j", "g", "d", "g", "c", "c"]) e.feed(k, "normal", log);
    expect(log).toEqual(["j5", "gd", "gcc"]);
  });
  it("respects modes and restarts on a wrong key", () => {
    const log: string[] = [];
    const e = run();
    e.feed("g", "visual", log);
    e.feed("c", "visual", log);
    expect(e.flush("visual", log)).toBe(true);
    expect(e.feed("enter", "normal", log).kind).toBe("unbound");
    e.feed("enter", "symbol", log);
    e.feed("g", "normal", log);
    e.feed("j", "normal", log);
    expect(log).toEqual(["gc", "def", "j1"]);
  });
  it("normalizes key events", () => {
    const k = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    expect(keyToken({ ...k, key: " " })).toBe("space");
    expect(keyToken({ ...k, key: "o", ctrlKey: true })).toBe("ctrl-o");
    expect(keyToken({ ...k, key: "Enter", shiftKey: true })).toBe("shift-enter");
    expect(keyToken({ ...k, key: "c", metaKey: true })).toBeNull();
  });
});

describe("tree", () => {
  it("compacts single-child folders and sorts", () => {
    const tree = buildTree(["crates/core/src/lib.rs", "crates/core/src/model.rs", "web/a.ts", "Cargo.lock"]);
    expect(tree.map((n) => n.name)).toEqual(["crates/core/src", "web", "Cargo.lock"]);
    expect(treeOrder(tree)).toEqual([0, 1, 2, 3]);
    expect(buildTree(["a/b.rs", "c/d.rs"], "d.rs").map((n) => n.name)).toEqual(["c"]);
  });
});

describe("jump list", () => {
  it("walks back and forward like vim", () => {
    const j = new JumpList<string>();
    j.push("a");
    j.push("b");
    expect(j.back("c")).toBe("b");
    expect(j.back("b")).toBe("a");
    expect(j.back("a")).toBeNull();
    expect(j.forward()).toBe("b");
    expect(j.forward()).toBe("c");
    expect(j.forward()).toBeNull();
  });
});

describe("markdown", () => {
  const paths = ["crates/diffd-core/src/feedback.rs", "src/main.rs"];
  it("resolves path:line references", () => {
    expect(resolveRef("feedback.rs:38", paths)).toEqual({ file: 0, line: 38 });
    expect(resolveRef("nope.rs:1", paths)).toBeNull();
  });
  it("links references, drops raw HTML", () => {
    const html = renderMarkdown("See `x` in feedback.rs:38 <img src=x onerror=alert(1)>", paths);
    expect(html).toContain('<a data-go="0:38">feedback.rs:38</a>');
    expect(html).not.toContain("<img");
  });
});

describe("regions", () => {
  it("maps regions to rows and folds them", async () => {
    const { applyFolds, regionRows } = await import("./diffModel");
    const model = fileModel(file());
    const region = {
      path: "src/a.rs",
      side: "new",
      lines: [2, 3],
      kind: "fold",
      summary: "s",
      text: "",
    } as const;
    expect(regionRows(model, { ...region, lines: [2, 3] })).toEqual([1, 2]);
    expect(regionRows(model, { ...region, lines: null })).toEqual([0, 1, 2, 3]);
    expect([...applyFolds(Uint8Array.from([1, 1, 1, 1]), [[1, 2]], new Set([2]))]).toEqual([1, 0, 1, 1]);
  });
});

describe("history", () => {
  const commit = (sha: string) => ({ sha, short: sha.slice(0, 3), subject: sha, author: "a", time: 0 });
  const h = { base: "base", commits: [commit("aaa1"), commit("bbb2")], worktree: true, truncated: false };

  it("lists points and steps, with the working tree last", () => {
    expect(points(h)).toEqual(["base", "aaa1", "bbb2", null]);
    expect(steps(h)).toBe(3);
    expect(rangeOf(h, step(0))).toEqual({ from: "base", to: "aaa1" });
    expect(rangeOf(h, step(2))).toEqual({ from: "bbb2", to: null });
    expect(rangeOf(h, null)).toBeNull();
  });

  it("labels spans", () => {
    expect(spanLabel(h, null)).toBe("All changes");
    expect(spanLabel(h, step(1))).toBe("bbb");
    expect(spanLabel(h, { from: 0, to: 2 })).toBe("aaa..bbb");
    expect(spanLabel(h, step(2))).toBe("Uncommitted changes");
    expect(spanLabel(h, { from: 1, to: 3 })).toBe("bbb + uncommitted");
  });

  it("keeps the same commits in view as the history grows", () => {
    const grown = { ...h, commits: [...h.commits, commit("ccc3")] };
    expect(carrySpan(h, grown, step(1))).toEqual(step(1));
    // Uncommitted changes ended at the working tree before and still do.
    expect(carrySpan(h, grown, step(2))).toEqual({ from: 2, to: 4 });
    const rewritten = { ...h, commits: [commit("zzz9")] };
    expect(carrySpan(h, rewritten, step(1))).toBeNull();
  });

  it("finds anchored code nearest where it was", () => {
    const lines = ["a", "b", "x", "a", "b"];
    expect(locate("a\nb", 4, lines)).toBe(4);
    expect(locate("a\nb", 1, lines)).toBe(1);
    expect(locate("q", 1, lines)).toBeNull();
  });
});

describe("tree with neighbours", () => {
  it("lists other files beside the open ones, unopened", () => {
    const nodes = buildTree(["src/a.rs"], "", ["src/b.rs", "src/a.rs", "docs/x.md"]);
    const flat = (ns: typeof nodes): string[] =>
      ns.flatMap((n) => (n.kind === "file" ? [`${n.path}:${n.index}`] : flat(n.children)));
    expect(flat(nodes)).toEqual(["docs/x.md:-1", "src/a.rs:0", "src/b.rs:-1"]);
    expect(treeOrder(nodes)).toEqual([0]);
    expect(parentDir("src/a.rs")).toBe("src/");
    expect(parentDir("top.md")).toBe("");
  });
});
