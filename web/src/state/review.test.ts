import { describe, expect, it } from "vitest";
import type { FileDiff, Snapshot } from "../api";
import { applyDelta } from "./review";

const file = (path: string, text: string): FileDiff => ({
  path,
  oldPath: null,
  status: "modified",
  language: null,
  omitted: null,
  details: [],
  collapsed: null,
  labels: [],
  added: 1,
  removed: 0,
  old: null,
  new: { lines: [text], syntax: [[]], novel: [[]] },
  rows: [],
  since: [],
});

const symbol = (name: string, f: number): Snapshot["symbols"][number] => ({
  name,
  kind: "function",
  file: f,
  side: "new",
  line: 1,
  start: 0,
  end: 1,
  lines: [1, 1],
});

describe("applyDelta", () => {
  const prev: Snapshot = {
    revision: 3,
    files: [file("a.rs", "a"), file("b.rs", "b"), file("c.rs", "c")],
    symbols: [symbol("fa", 0), symbol("fb", 1), symbol("fc", 2), symbol("fc2", 2)],
  };
  // b changes, a goes, d arrives first, c moves.
  const delta = {
    base: 3,
    revision: 4,
    paths: ["d.rs", "b.rs", "c.rs"],
    files: [file("d.rs", "d"), file("b.rs", "b2")],
    symbols: [symbol("fd", 0), symbol("fb2", 1)],
  };

  it("rebuilds the next revision, keeping unchanged files as the same objects", () => {
    const next = applyDelta(prev, delta);
    expect(next).toEqual({
      revision: 4,
      files: [file("d.rs", "d"), file("b.rs", "b2"), file("c.rs", "c")],
      symbols: [symbol("fd", 0), symbol("fb2", 1), symbol("fc", 2), symbol("fc2", 2)],
    });
    expect(next?.files[2]).toBe(prev.files[2]);
  });

  it("applies only to its base, with every file it counts on", () => {
    expect(applyDelta({ ...prev, revision: 2 }, delta)).toBeNull();
    expect(applyDelta({ ...prev, files: prev.files.slice(0, 2) }, delta)).toBeNull();
  });
});
