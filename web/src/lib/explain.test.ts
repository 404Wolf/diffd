import { describe, expect, it } from "vitest";
import { explainRows } from "./explain";

describe("explainRows", () => {
  it("is empty for a review without an explanation, as before", () => {
    expect(explainRows(null)).toEqual([]);
    expect(explainRows(undefined)).toEqual([]);
    expect(explainRows({})).toEqual([]);
  });

  it("shows the filled parts in the template's order", () => {
    const rows = explainRows({
      why: "Callers passed 0.",
      whatChanged: "- Clamp `src/lib.rs:2`",
      verification: "Not run",
    });
    expect(rows).toEqual([
      { label: "What changed", text: "- Clamp `src/lib.rs:2`" },
      { label: "Why", text: "Callers passed 0." },
      { label: "Verification", text: "Not run" },
    ]);
  });

  it("says so when Verification is missing, and skips other blank parts", () => {
    const rows = explainRows({ whatChanged: "x", before: "  ", after: null });
    expect(rows).toEqual([
      { label: "What changed", text: "x" },
      { label: "Verification", text: null },
    ]);
  });
});
