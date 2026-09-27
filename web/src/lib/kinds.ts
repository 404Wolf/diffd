/**
 * The agent's groups and labels, applied to the files in the diff. Patterns
 * match as on the server (`crates/diffd-core/src/kinds.rs`), which checks them
 * when the agent sends them; the tests share their cases.
 */
import type { FileDiff, Layout, Region } from "../api";

/** Whether an agent's pattern names a path: a path, a directory, or a glob (`*`, `**`, `?`). */
export function matches(pattern: string, path: string): boolean {
  const p = pattern.trim().replace(/^(\.\/)+/, "");
  if (p === "") return false;
  const dir = p.replace(/\/+$/, "");
  if (path === dir || path.startsWith(`${dir}/`)) return true;
  if (globRe(p).test(path)) return true;
  return !p.includes("/") && globRe(p).test(path.slice(path.lastIndexOf("/") + 1));
}

const compiled = new Map<string, RegExp>();
function globRe(glob: string): RegExp {
  let re = compiled.get(glob);
  if (re) return re;
  let src = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      // `**/` also matches nothing: `a/**/b` names `a/b`.
      if (glob[i + 2] === "/") {
        src += "(?:.*/)?";
        i += 2;
      } else {
        src += ".*";
        i += 1;
      }
    } else if (c === "*") src += "[^/]*";
    else if (c === "?") src += "[^/]";
    else src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  re = new RegExp(`^${src}$`);
  compiled.set(glob, re);
  return re;
}

/** A group of files, resolved against the diff. */
export interface FileGroup {
  readonly title: string;
  readonly summary: string | null;
  readonly paths: readonly string[];
}

/** The title of the group for files the agent didn't place. */
export const OTHER_GROUP = "Other changes";

/** Each file in the first group naming it, groups in the agent's order; the rest under "Other changes". */
export function resolveGroups(layout: Layout, paths: readonly string[]): FileGroup[] {
  if (layout.groups.length === 0) return [];
  const placed = new Set<string>();
  const groups: FileGroup[] = [];
  for (const g of layout.groups) {
    const mine: string[] = [];
    // In the order the agent listed its patterns, then the diff's order within each.
    for (const pattern of g.files)
      for (const path of paths)
        if (!placed.has(path) && matches(pattern, path)) {
          placed.add(path);
          mine.push(path);
        }
    if (mine.length > 0) groups.push({ title: g.title, summary: g.summary, paths: mine });
  }
  const rest = paths.filter((p) => !placed.has(p));
  if (rest.length > 0) groups.push({ title: OTHER_GROUP, summary: null, paths: rest });
  return groups;
}

/** A file's labels: diffd's own (`test`, `generated`), the agent's, and `test` for whole-file test regions. */
export function labelsOf(file: FileDiff, layout: Layout, regions: readonly Region[]): string[] {
  const out = new Set(file.labels);
  for (const l of layout.labels) if (l.files.some((p) => matches(p, file.path))) out.add(l.name);
  if (regions.some((r) => r.kind === "test" && r.lines === null && r.path === file.path)) out.add("test");
  return [...out];
}
