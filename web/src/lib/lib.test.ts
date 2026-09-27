import { describe, expect, it } from "vitest";
import type { FileDiff } from "../gen/FileDiff";
import { fromRuns, toRuns } from "../state/persist";
import { diagnosticSpan, diagnosticsOn, IDENT, wordAt } from "./code";
import {
  blocks,
  expandGap,
  fileModel,
  growAround,
  initialVisible,
  nearestGap,
  shrinkAround,
} from "./diffModel";
import { carrySpan, locate, points, rangeOf, spanLabel, step, stepAhead, steps } from "./history";
import { JumpList } from "./jumps";
import { KeyEngine, keyToken } from "./keymap";
import { Lru } from "./lru";
import { renderMarkdown, resolveRef } from "./markdown";
import { changeMarks, lineHtml, rowHtml } from "./render";
import { CLASS_KINDS, definition, FUNCTION_KINDS, pair, paragraph, tag } from "./textObjects";
import { buildTree, parentDir, treeOrder } from "./tree";

const file = (): FileDiff => ({
  path: "src/a.rs",
  oldPath: null,
  status: "modified",
  language: "Rust",
  omitted: null,
  details: [],
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
  it("colors blanks inside a change only when the change is all blanks", () => {
    expect(lineHtml("a  b", [0, 1, 0, 3, 4, 0], [0, 4], { novelClass: "nv-add" })).toBe(
      '<span class="s-keyword nv-add">a</span>  <span class="s-keyword nv-add">b</span>',
    );
    expect(lineHtml("x   ", [0, 1, 0], [1, 4], { novelClass: "nv-add" })).toBe(
      '<span class="s-keyword">x</span><span class="nv-add">   </span>',
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
    // AltGr (Ctrl+Alt on Windows) and Option on a Mac type brackets on many layouts.
    expect(keyToken({ ...k, key: "]", ctrlKey: true, altKey: true })).toBe("]");
    expect(keyToken({ ...k, key: "{", altKey: true })).toBe("{");
    expect(keyToken({ ...k, key: "f", altKey: true })).toBeNull();
    expect(keyToken({ ...k, key: "ß", altKey: true })).toBeNull();
    expect(keyToken({ ...k, key: "c", metaKey: true })).toBeNull();
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
    expect(html).toContain('<a href="#" data-go="crates/diffd-core/src/feedback.rs:38">feedback.rs:38</a>');
    expect(renderMarkdown("[docs](https://example.com)", paths)).toContain(
      'target="_blank" rel="noopener noreferrer"',
    );
    expect(html).not.toContain("<img");
  });
  it("links paths in any script, and code spans with spaces", () => {
    const odd = ["ünï/f.txt", "docs/my notes.md"];
    expect(renderMarkdown("see ünï/f.txt:2", odd)).toContain('data-go="ünï/f.txt:2">ünï/f.txt:2</a>');
    expect(renderMarkdown("see `my notes.md:3`", odd)).toContain('data-go="docs/my notes.md:3"');
  });
  it("turns images into links, so nothing loads", () => {
    const html = renderMarkdown("![pixel](https://tracker.example/p.gif)", paths);
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://tracker.example/p.gif"');
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

  it("guesses the step after next from the direction of the walk", () => {
    // Forward from the whole review, from a range, or step by step.
    expect(stepAhead(h, null, step(0))).toEqual(step(1));
    expect(stepAhead(h, { from: 0, to: 2 }, step(1))).toEqual(step(2));
    expect(stepAhead(h, step(0), step(1))).toEqual(step(2));
    // Backward.
    expect(stepAhead(h, step(2), step(1))).toEqual(step(0));
    expect(stepAhead(h, step(1), step(0))).toBeNull();
    // Nothing past the last step, or after a range of several.
    expect(stepAhead(h, step(1), step(2))).toBeNull();
    expect(stepAhead(h, null, { from: 0, to: 2 })).toBeNull();
    expect(stepAhead(h, step(0), null)).toBeNull();
  });
});

describe("most recently used", () => {
  it("keeps the newest and most used entries", () => {
    const lru = new Lru<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.get("a")).toBe(1);
    lru.set("c", 3);
    expect([lru.peek("a"), lru.peek("b"), lru.peek("c")]).toEqual([1, undefined, 3]);
    // Peeking doesn't count as a use.
    lru.peek("a");
    lru.set("d", 4);
    expect([lru.peek("a"), lru.peek("c"), lru.peek("d")]).toEqual([undefined, 3, 4]);
    lru.deleteWhere((k) => k === "c");
    expect(lru.size).toBe(1);
  });
});

describe("tree with neighbours", () => {
  it("lists other files beside the open ones, unopened", () => {
    const nodes = buildTree(["src/a.rs"], "", ["src/b.rs", "src/a.rs", "docs/x.md"]);
    const flat = (ns: readonly (typeof nodes)[number][]): string[] =>
      ns.flatMap((n) => (n.kind === "file" ? [`${n.path}:${n.index}`] : flat(n.children)));
    expect(flat(nodes)).toEqual(["docs/x.md:-1", "src/a.rs:0", "src/b.rs:-1"]);
    expect(treeOrder(nodes)).toEqual([0]);
    expect(parentDir("src/a.rs")).toBe("src/");
    expect(parentDir("top.md")).toBe("");
  });
});

describe("text objects", () => {
  const code = [
    "fn outer() {", // 1
    "    let a = (1,", // 2
    "        2);", // 3
    "    if a.0 > 0 {", // 4
    '        println!("{}", "}");', // 5
    "    }", // 6
    "}", // 7
    "", // 8
    "fn next<'a>(x: &'a str) {}", // 9
  ];
  it("pairs: innermost, quotes skipped, a vs i", () => {
    expect(pair(code, 5, 8, "{", "}", true)).toEqual([4, 6]);
    expect(pair(code, 5, 8, "{", "}", false)).toEqual([5, 5]);
    expect(pair(code, 3, 8, "(", ")", false)).toEqual([2, 3]); // fewer than three lines: same as a(
    expect(pair(code, 3, 8, "{", "}", false)).toEqual([2, 6]);
    expect(pair(code, 3, 8, "(", ")", true)).toEqual([2, 3]);
    expect(pair(code, 9, 12, "(", ")", true)).toEqual([9, 9]); // lifetimes aren't quotes
    expect(pair(code, 8, 0, "{", "}", true)).toBeNull();
  });
  it("paragraphs", () => {
    const text = ["a", "b", "", "", "c"];
    expect(paragraph(text, 2, false)).toEqual([1, 2]);
    expect(paragraph(text, 2, true)).toEqual([1, 4]);
    expect(paragraph(text, 5, true)).toEqual([3, 5]); // no blank after: take the ones before
    expect(paragraph(text, 3, false)).toEqual([3, 4]);
  });
  it("tags, innermost, skipping self-closing ones", () => {
    const jsx = ["<div>", "  <span>", "    hi <br/>", "  </span>", "  <img src='x' />", "</div>"];
    expect(tag(jsx, 3, true)).toEqual([2, 4]);
    expect(tag(jsx, 5, false)).toEqual([2, 5]);
    expect(tag(jsx, 5, true)).toEqual([1, 6]);
  });
  it("definitions", () => {
    const spans = [
      { kind: "class", lines: [1, 10] as [number, number] },
      { kind: "method", lines: [3, 6] as [number, number] },
    ];
    expect(definition(spans, FUNCTION_KINDS, 4, true)).toEqual([3, 6]);
    expect(definition(spans, FUNCTION_KINDS, 4, false)).toEqual([4, 5]);
    expect(definition(spans, CLASS_KINDS, 4, true)).toEqual([1, 10]);
    expect(definition(spans, FUNCTION_KINDS, 8, true)).toBeNull();
  });
});

describe("positions in code", () => {
  it("finds the word under a column", () => {
    expect(wordAt("let foo_bar = baz;", 5)).toEqual({ text: "foo_bar", col: 4 });
    expect(wordAt("let foo_bar = baz;", 12)).toBeNull();
    expect(wordAt("$el.x", 0)).toEqual({ text: "$el", col: 0 });
    // Columns are UTF-16 units, like JS strings and language servers.
    expect(wordAt("🦀 crab", 3)).toEqual({ text: "crab", col: 3 });
  });
  it("spans diagnostics over lines, and gives zero-width ones a character", () => {
    const d = {
      line: 2,
      col: 4,
      endLine: 3,
      endCol: 2,
      severity: "error" as const,
      message: "",
      source: null,
    };
    expect(diagnosticSpan(d, 1, 10)).toBeNull();
    expect(diagnosticSpan(d, 2, 10)).toEqual([4, 10]);
    expect(diagnosticSpan(d, 3, 10)).toEqual([0, 2]);
    const point = { ...d, line: 1, endLine: 1, col: 3, endCol: 3 };
    expect(diagnosticSpan(point, 1, 10)).toEqual([3, 4]);
    expect(diagnosticSpan({ ...point, col: 10, endCol: 10 }, 1, 10)).toEqual([9, 10]);
    expect(diagnosticSpan({ ...point, col: 0, endCol: 0 }, 1, 0)).toBeNull();
  });
  it("orders diagnostics on a line worst first", () => {
    const at = (severity: "error" | "warning" | "hint", line: number) => ({
      line,
      col: 0,
      endLine: line,
      endCol: 1,
      severity,
      message: severity,
      source: null,
    });
    expect(
      diagnosticsOn([at("hint", 1), at("error", 1), at("warning", 1), at("error", 2)], 1).map(
        (d) => d.message,
      ),
    ).toEqual(["error", "warning", "hint"]);
  });
});

describe("remembered folds", () => {
  it("round-trips visible rows as runs, only for a file of the same shape", () => {
    const v = new Uint8Array([0, 1, 1, 0, 1, 0, 0, 1]);
    const runs = toRuns(v);
    expect(runs).toEqual([
      [1, 3],
      [4, 5],
      [7, 8],
    ]);
    expect(fromRuns({ rows: 8, runs }, 8)).toEqual(v);
    expect(fromRuns({ rows: 8, runs }, 9)).toBeNull();
    expect(toRuns(new Uint8Array())).toEqual([]);
  });
});

describe("jump list remapping", () => {
  it("rewrites entries, drops missing ones, and keeps the position", () => {
    const j = new JumpList<number>();
    for (const n of [1, 2, 3, 4]) j.push(n);
    j.back(5);
    j.back(5);
    j.remap((n) => (n === 2 ? null : n * 10));
    expect(j.position).toEqual({ at: 1, length: 4 }); // still at what was 3, now 30
    expect(j.forward()).toBe(40);
  });
});

describe("identifiers in any script", () => {
  it("finds words the way `w` walks them", () => {
    expect("let 名前 = é_1 + $x".match(IDENT)).toEqual(["let", "名前", "é_1", "$x"]);
  });
});

describe("context around the cursor's hunk", () => {
  const vis = (s: string) => Uint8Array.from(s, (c) => (c === "1" ? 1 : 0));
  const str = (v: Uint8Array) => [...v].join("");
  it("ctrl-enter grows both ways, clamped to the file", () => {
    expect(str(growAround(vis("0000110000"), 4, 2))).toBe("0011111100");
    expect(str(growAround(vis("1100000000"), 0, 3))).toBe("1111100000");
    expect(str(growAround(vis("0000000000"), 5, 1)), "a hidden row opens around itself").toBe("0000111000");
  });
  it("ctrl-shift-enter shrinks both ways, keeping changes, their context and the cursor", () => {
    const keep = vis("0000110000");
    expect(str(shrinkAround(vis("0111111110"), 4, 2, keep))).toBe("0001111000");
    expect(str(shrinkAround(vis("0001111000"), 4, 2, keep))).toBe("0000110000");
    expect(str(shrinkAround(vis("0000110000"), 4, 2, keep)), "never below the changes").toBe("0000110000");
    expect(
      str(shrinkAround(vis("1111111111"), 0, 3, vis("0000000000"))),
      "nothing above the cursor to hide",
    ).toBe("1111111000");
  });
});
