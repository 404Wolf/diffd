import { describe, expect, it } from "vitest";
import type { FileDiff } from "../api";
import { labelsOf, matches, OTHER_GROUP, resolveGroups } from "./kinds";

/** The same cases as `crates/diffd-core/src/kinds.rs`. */
const CASES: [string, string, boolean][] = [
  ["web", "web/src/a.ts", true],
  ["web/", "web/src/a.ts", true],
  ["web", "webby/a.ts", false],
  ["src/lib.rs", "src/lib.rs", true],
  ["*.sqlx", "crates/x/.sqlx/q.sqlx", true],
  ["*.ts", "web/src/a.ts", true],
  ["web/*.ts", "web/src/a.ts", false],
  ["web/**/*.ts", "web/src/a.ts", true],
  ["web/**/*.ts", "web/a.ts", true],
  ["web/**", "web/src/deep/a.tsx", true],
  ["**/migrations/**", "db/migrations/001.sql", true],
  ["crates/*/src/*.rs", "crates/core/src/lib.rs", true],
  ["crates/*/src/*.rs", "crates/core/src/x/lib.rs", false],
  ["src/?.rs", "src/a.rs", true],
  ["Cargo.lock", "sub/Cargo.lock", true],
  ["", "a", false],
];

describe("agent patterns", () => {
  it("match like the server's", () => {
    for (const [pattern, path, want] of CASES)
      expect(matches(pattern, path), `${pattern} vs ${path}`).toBe(want);
  });

  it("group files in the agent's order, the rest last", () => {
    const layout = {
      agent: null,
      labels: [],
      groups: [
        { title: "API", summary: "The routes.", files: ["src/api/**", "src/lib.rs"] },
        { title: "Empty", summary: null, files: ["nothing/**"] },
        { title: "Again", summary: null, files: ["src/api/a.rs"] },
      ],
    };
    const groups = resolveGroups(layout, ["README.md", "src/api/a.rs", "src/lib.rs", "src/api/b.rs"]);
    expect(groups.map((g) => g.title)).toEqual(["API", OTHER_GROUP]);
    expect(groups[0]?.paths).toEqual(["src/api/a.rs", "src/api/b.rs", "src/lib.rs"]);
    expect(groups[1]?.paths).toEqual(["README.md"]);
    expect(resolveGroups({ agent: null, labels: [], groups: [] }, ["a"])).toEqual([]);
  });

  it("label files from all three sources", () => {
    const file = { path: "web/src/a.test.ts", labels: ["test"] } as unknown as FileDiff;
    const layout = { agent: null, groups: [], labels: [{ name: "frontend", files: ["web"] }] };
    expect(labelsOf(file, layout, []).sort()).toEqual(["frontend", "test"]);
    const plain = { path: "src/x.rs", labels: [] } as unknown as FileDiff;
    const region = {
      path: "src/x.rs",
      side: "new",
      lines: null,
      kind: "test",
      summary: null,
      text: "",
    } as const;
    expect(labelsOf(plain, layout, [region])).toEqual(["test"]);
  });
});
