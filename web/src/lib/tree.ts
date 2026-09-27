/** The file tree: folders with single-child chains compacted, like GitHub. */

export interface TreeDir {
  readonly kind: "dir";
  /** Display name, possibly several segments (`src/lib`). */
  readonly name: string;
  /** Full path with a trailing slash; stable key for open/closed state. */
  readonly path: string;
  readonly children: readonly TreeNode[];
}

export interface TreeFile {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
  /** Index in the snapshot's files, or -1 for a file that isn't open (a neighbour). */
  readonly index: number;
}

export type TreeNode = TreeDir | TreeFile;

interface Building {
  dirs: Map<string, Building>;
  files: { name: string; path: string; index: number }[];
}

/** `paths` are the open files (by index); `extra` are other files to list alongside them. */
export function buildTree(paths: readonly string[], filter = "", extra: readonly string[] = []): TreeNode[] {
  const root: Building = { dirs: new Map(), files: [] };
  const q = filter.toLowerCase();
  const open = new Set(paths);
  const all: [string, number][] = [
    ...paths.map((p, i): [string, number] => [p, i]),
    ...extra.filter((p) => !open.has(p)).map((p): [string, number] => [p, -1]),
  ];
  all.forEach(([path, index]) => {
    if (q && !path.toLowerCase().includes(q)) return;
    const parts = path.split("/");
    const name = parts.pop() ?? path;
    let node = root;
    for (const part of parts) {
      let next = node.dirs.get(part);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(part, next);
      }
      node = next;
    }
    node.files.push({ name, path, index });
  });
  return convert(root, "");
}

function convert(node: Building, prefix: string): TreeNode[] {
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const dirs = [...node.dirs.entries()].sort(([a], [b]) => byName(a, b));
  const out: TreeNode[] = [];
  for (const [name0, child0] of dirs) {
    let name = name0;
    let child = child0;
    while (child.files.length === 0 && child.dirs.size === 1) {
      const [[n, c]] = [...child.dirs.entries()] as [[string, Building]];
      name += `/${n}`;
      child = c;
    }
    const path = `${prefix}${name}/`;
    out.push({ kind: "dir", name, path, children: convert(child, path) });
  }
  for (const f of [...node.files].sort((a, b) => byName(a.name, b.name))) {
    out.push({ kind: "file", name: f.name, path: f.path, index: f.index });
  }
  return out;
}

/** File indices in tree order (what `]f` walks). */
export function treeOrder(nodes: readonly TreeNode[]): number[] {
  return nodes.flatMap((n) => (n.kind === "file" ? (n.index >= 0 ? [n.index] : []) : treeOrder(n.children)));
}

/** The folder a path is in, with a trailing slash (`""` at the top). */
export const parentDir = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);
