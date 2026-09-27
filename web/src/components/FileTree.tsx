import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { createStore } from "solid-js/store";
import type { FileDiff } from "../gen/FileDiff";
import type { FileGroup } from "../lib/kinds";
import { STATUS } from "../lib/status";
import { buildTree, parentDir, type TreeDir, type TreeFile, type TreeNode } from "../lib/tree";
import type { Commands } from "../state/commands";
import type { Review } from "../state/review";
import type { TreeMode, View } from "../state/view";

/** Rows are one height, so the list only renders the ones in view (a project can have 100k files). */
const ROW = 20;
const OVERSCAN = 12;

interface Row {
  readonly node: TreeNode | GroupNode;
  readonly depth: number;
}

/** A group of related changes, in the Groups tab. */
interface GroupNode {
  readonly kind: "group";
  readonly group: FileGroup;
  /** How many of its files are shown (some may be hidden by labels). */
  readonly count: number;
}

/**
 * The files drawer. "Diff": the changed files, GitHub style (compact folders,
 * status, a five-block +/− bar), and on request the other files in their
 * folders. "Project": every file in the repository, changes marked.
 * "Groups": the changed files in the agent's groups of related changes, in
 * the order the buffer shows them when reading by group.
 */
export function FileTree(props: { review: Review; view: View; cmd: Commands; current: () => number | null }) {
  const [filter, setFilter] = createSignal("");
  const mode = () => props.view.treeMode();
  /** Folders whose other files (not in the diff) are listed too, in the diff's tree. */
  const [neighbours, setNeighbours] = createStore<Record<string, boolean>>({});
  const showNeighbours = (dir: string, on: boolean) => {
    if (on) props.review.loadRepoFiles();
    setNeighbours(dir, on);
  };
  createEffect(() => {
    if (mode() === "project") props.review.loadRepoFiles();
  });
  const extra = createMemo(() => {
    const all = props.review.repoFiles() ?? [];
    return mode() === "project" ? all : all.filter((p) => neighbours[parentDir(p)]);
  });
  const tree = createMemo(() => buildTree(props.review.paths(), filter(), extra()));
  /** Folders (with a trailing slash) that hold a changed file, at any depth. */
  const changedDirs = createMemo(() => {
    const dirs = new Set<string>();
    for (const p of props.review.paths()) {
      for (let i = p.indexOf("/"); i >= 0; i = p.indexOf("/", i + 1)) dirs.add(p.slice(0, i + 1));
    }
    return dirs;
  });
  const isOpen = (dir: TreeDir) =>
    filter() !== "" || props.view.folderOpen(mode(), dir.path, changedDirs().has(dir.path));
  const groupRows = (): Row[] => {
    const q = filter().toLowerCase();
    const index = new Map(props.review.paths().map((p, i) => [p, i]));
    return props.review.groups().flatMap((group) => {
      const files = group.paths.flatMap((path) => {
        const i = index.get(path);
        return i === undefined || (q && !path.toLowerCase().includes(q))
          ? []
          : [{ node: { kind: "file", name: path, path, index: i } as TreeFile, depth: 1 }];
      });
      if (files.length === 0) return [];
      const header: Row = { node: { kind: "group", group, count: files.length }, depth: 0 };
      return isGroupOpen(group) ? [header, ...files] : [header];
    });
  };
  const isGroupOpen = (g: FileGroup) => filter() !== "" || props.view.folderOpen("groups", g.title, true);
  const rows = createMemo(() => {
    if (mode() === "groups") return groupRows();
    const out: Row[] = [];
    const walk = (nodes: readonly TreeNode[], depth: number) => {
      for (const node of nodes) {
        out.push({ node, depth });
        if (node.kind === "dir" && isOpen(node)) walk(node.children, depth + 1);
      }
    };
    walk(tree(), 0);
    return out;
  });

  // The window of rows to render.
  let list: HTMLDivElement | undefined;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(600);
  onMount(() => {
    if (!list) return;
    const observer = new ResizeObserver(() => setHeight(list?.clientHeight ?? 600));
    observer.observe(list);
    onCleanup(() => observer.disconnect());
  });
  const first = () => Math.max(0, Math.floor(scrollTop() / ROW) - OVERSCAN);
  const shown = createMemo(() => rows().slice(first(), Math.ceil((scrollTop() + height()) / ROW) + OVERSCAN));
  // Keep the file you're on in view as you move between files.
  createEffect(() => {
    const current = props.current();
    if (current === null || !list) return;
    const at = untrack(rows).findIndex((r) => r.node.kind === "file" && r.node.index === current);
    if (at < 0) return;
    const top = at * ROW;
    if (top < list.scrollTop || top + ROW > list.scrollTop + list.clientHeight)
      list.scrollTop = top - list.clientHeight / 2;
  });

  const unreadFiles = createMemo(() => {
    const set = new Set<string>();
    for (const a of props.review.unread()) {
      if ("threadId" in a.kind) {
        const id = a.kind.threadId;
        const t = props.review.threads().find((x) => x.id === id);
        if (t) set.add(t.anchor.path);
      }
    }
    return set;
  });
  /** Language server errors and warnings in a file, or null when it's clean. */
  const problems = (path: string) => {
    const all = props.review.conv.diagnostics[path] ?? [];
    const errors = all.filter((d) => d.severity === "error").length;
    const warnings = all.filter((d) => d.severity === "warning").length;
    return errors + warnings > 0 ? { errors, warnings } : null;
  };
  const threadCount = (path: string) =>
    props.review.threads().filter((t) => t.anchor.path === path && t.kind.type === "comment").length;

  const Folder = (p: { dir: TreeDir }) => (
    <div class="group flex items-center rounded hover:bg-hover">
      <button
        type="button"
        class="flex h-5 min-w-0 flex-1 cursor-pointer items-center gap-1 px-1 text-left text-[12.5px] whitespace-nowrap text-muted"
        aria-expanded={isOpen(p.dir)}
        data-tree-dir={p.dir.path}
        onClick={() => props.view.setFolderOpen(mode(), p.dir.path, !isOpen(p.dir))}
      >
        <span
          class="w-3 flex-none text-center text-[8px] text-subtle transition-transform"
          classList={{ "-rotate-90": !isOpen(p.dir) }}
        >
          ▼
        </span>
        <span class="truncate">{p.dir.name}</span>
      </button>
      <Show when={mode() === "diff"}>
        <button
          type="button"
          class="mr-0.5 flex-none cursor-pointer rounded px-1 text-[11px] leading-4 text-subtle hover:bg-bg hover:text-fg"
          classList={{
            "invisible group-hover:visible": !neighbours[p.dir.path],
            "text-accent": neighbours[p.dir.path],
          }}
          title={neighbours[p.dir.path] ? "Hide files not in the diff" : "Show every file in this folder"}
          aria-label={`Other files in ${p.dir.path}`}
          aria-pressed={Boolean(neighbours[p.dir.path])}
          onClick={() => showNeighbours(p.dir.path, !neighbours[p.dir.path])}
        >
          ⋯
        </button>
      </Show>
    </div>
  );

  /** A group's title: opens or closes it; its summary is the tooltip. */
  const GroupHeader = (p: { node: GroupNode }) => {
    const open = () => isGroupOpen(p.node.group);
    return (
      <button
        type="button"
        class="flex h-5 w-full cursor-pointer items-center gap-1 rounded px-1 text-left text-[12.5px] font-semibold whitespace-nowrap text-fg hover:bg-hover"
        aria-expanded={open()}
        data-tree-group={p.node.group.title}
        title={p.node.group.summary ?? p.node.group.title}
        onClick={() => props.view.setFolderOpen("groups", p.node.group.title, !open())}
      >
        <span
          class="w-3 flex-none text-center text-[8px] text-subtle transition-transform"
          classList={{ "-rotate-90": !open() }}
        >
          ▼
        </span>
        <span class="font-mono text-[10.5px] font-normal text-subtle">
          {props.review.groups().indexOf(p.node.group) + 1}
        </span>
        <span class="min-w-0 flex-1 truncate">{p.node.group.title}</span>
        <span class="font-mono text-[10.5px] font-normal text-subtle">{p.node.count}</span>
      </button>
    );
  };

  /** A file that isn't in the diff: opening it fetches it. */
  const Other = (p: { file: TreeFile }) => (
    <button
      type="button"
      class="flex h-5 w-full cursor-pointer items-center gap-1.5 rounded px-1 text-left text-[12.5px] whitespace-nowrap hover:bg-hover hover:text-fg"
      classList={{ "text-subtle italic": mode() === "diff", "text-muted": mode() === "project" }}
      title={`${p.file.path} · not changed; open to read or comment`}
      data-neighbour={p.file.path}
      onClick={() => void props.cmd.openPath(p.file.path)}
    >
      <span class="w-3 flex-none" />
      <span class="min-w-0 flex-1 truncate">{p.file.name}</span>
    </button>
  );

  const Changed = (p: { file: TreeFile }) => {
    const file = () => props.review.snapshot().files[p.file.index] as FileDiff;
    return (
      <button
        type="button"
        class="flex h-5 w-full cursor-pointer items-center gap-1.5 rounded px-1 text-left text-[12.5px] whitespace-nowrap hover:bg-hover"
        classList={{ "bg-accent-soft": props.current() === p.file.index }}
        aria-current={props.current() === p.file.index}
        data-tree-file={p.file.path}
        data-context={props.review.isContext(p.file.index) ? "" : undefined}
        title={`${p.file.path}${file().collapsed ? ` · collapsed: ${file().collapsed}` : ""}`}
        onClick={() => {
          const dir = parentDir(p.file.path);
          if (mode() !== "diff") return props.cmd.openFile(p.file.index);
          // Clicking the file you're on again hides its folder's other files.
          if (props.current() === p.file.index && neighbours[dir]) return showNeighbours(dir, false);
          props.cmd.openFile(p.file.index);
          // Opening a file shows what else is in its folder.
          showNeighbours(dir, true);
        }}
      >
        <span
          class={`w-3 flex-none text-center font-mono text-[10px] font-semibold ${props.view.flags.viewed[p.file.path] ? "text-subtle" : STATUS[file().status].color}`}
        >
          {props.view.flags.viewed[p.file.path] ? "✓" : STATUS[file().status].letter}
        </span>
        <span class="min-w-0 flex-1 truncate" classList={{ "text-subtle": props.view.hidden(p.file.index) }}>
          <Show when={mode() === "groups"} fallback={p.file.name}>
            <span class="text-subtle">{parentDir(p.file.path)}</span>
            {p.file.path.slice(parentDir(p.file.path).length)}
          </Show>
        </span>
        <span class="flex items-center gap-1.5 font-mono text-[10.5px] text-subtle">
          <Show when={unreadFiles().has(p.file.path)}>
            <span class="size-1.5 rounded-full bg-accent" title="Unread reply" />
          </Show>
          <Show when={threadCount(p.file.path) > 0}>
            <span classList={{ "font-semibold text-accent": unreadFiles().has(p.file.path) }} title="Threads">
              ◆{threadCount(p.file.path)}
            </span>
          </Show>
          <Show when={problems(p.file.path)}>
            {(pr) => (
              <span
                data-problems={p.file.path}
                classList={{ "text-del": pr().errors > 0, "text-warn": pr().errors === 0 }}
                title={`${pr().errors} errors, ${pr().warnings} warnings`}
              >
                {pr().errors > 0 ? `✖${pr().errors}` : `▲${pr().warnings}`}
              </span>
            )}
          </Show>
          <DiffBar added={file().added} removed={file().removed} />
        </span>
      </button>
    );
  };

  const Tab = (p: { value: TreeMode; children: JSX.Element }) => (
    <button
      type="button"
      role="tab"
      aria-selected={mode() === p.value}
      class="-mb-px cursor-pointer border-b-2 px-1.5 pb-0.5 text-[11px] font-semibold tracking-wider uppercase"
      classList={{
        "border-accent text-fg": mode() === p.value,
        "border-transparent text-muted hover:text-fg": mode() !== p.value,
      }}
      onClick={() => props.view.setTreeMode(p.value)}
    >
      {p.children}
    </button>
  );
  const iconButton =
    "grid size-5 cursor-pointer place-items-center rounded text-[12px] text-muted hover:bg-hover hover:text-fg";

  return (
    <nav
      aria-label={
        mode() === "diff" ? "Changed files" : mode() === "groups" ? "The agent's tour" : "Project files"
      }
      class="flex h-full flex-col"
    >
      <div class="flex-none px-2 pt-1.5 pb-1">
        <div
          class="mb-1.5 flex items-center gap-1 border-b border-line"
          role="tablist"
          aria-label="Which files"
        >
          <Tab value="diff">
            Diff <span class="font-medium tracking-normal text-subtle">{props.review.diffCount()}</span>
          </Tab>
          <Tab value="groups">
            Tour
            <Show when={props.review.groups().length > 0}>
              <span class="font-medium tracking-normal text-subtle"> {props.review.groups().length}</span>
            </Show>
          </Tab>
          <Tab value="project">
            Project
            <Show when={props.review.repoFiles()}>
              {(all) => <span class="font-medium tracking-normal text-subtle"> {all().length}</span>}
            </Show>
          </Tab>
          <span class="ml-auto flex items-center pb-0.5">
            <button
              type="button"
              class={iconButton}
              title="Collapse all folders (space t c)"
              aria-label="Collapse all folders"
              onClick={() => props.view.setAllFolders(false)}
            >
              ⊟
            </button>
            <button
              type="button"
              class={iconButton}
              title="Expand all folders (space t o)"
              aria-label="Expand all folders"
              onClick={() => props.view.setAllFolders(true)}
            >
              ⊞
            </button>
          </span>
        </div>
        <input
          type="search"
          placeholder={mode() === "diff" ? "Filter files" : "Find a file in the project"}
          aria-label="Filter files"
          autocomplete="off"
          class="h-6 w-full rounded border border-line bg-bg px-2 text-xs"
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
        <Labels review={props.review} />
        <Show when={mode() === "groups" && props.review.groups().length === 0}>
          <p class="px-1 pt-1.5 text-[11.5px] text-subtle">
            No tour yet. Ask the agent for one: it groups the changes into chapters, in the order to read
            them.
          </p>
        </Show>
        <Show when={mode() === "project" && props.review.repoFiles() === null}>
          <p class="px-1 pt-1.5 text-[11.5px] text-subtle">Listing the project's files…</p>
        </Show>
      </div>
      <div
        ref={list}
        class="min-h-0 flex-1 overflow-auto px-1.5 pb-2.5"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div class="relative" style={{ height: `${rows().length * ROW}px` }}>
          <ul class="absolute inset-x-0" style={{ transform: `translateY(${first() * ROW}px)` }}>
            <For each={shown()}>
              {(row) => (
                <li style={{ "padding-left": `${row.depth * 10}px` }} class="h-5">
                  <Switch>
                    <Match when={row.node.kind === "group" && row.node}>
                      {(g) => <GroupHeader node={g()} />}
                    </Match>
                    <Match when={row.node.kind === "dir" && row.node}>
                      {(dir) => <Folder dir={dir()} />}
                    </Match>
                    <Match when={row.node.kind === "file" && row.node.index < 0 && row.node}>
                      {(f) => <Other file={f()} />}
                    </Match>
                    <Match when={row.node.kind === "file" && row.node}>{(f) => <Changed file={f()} />}</Match>
                  </Switch>
                </li>
              )}
            </For>
          </ul>
        </div>
      </div>
    </nav>
  );
}

/** Toggles that hide every file with a label: tests, generated code, the agent's own (frontend, …). */
function Labels(props: { review: Review }) {
  return (
    <Show when={props.review.labelCounts().length > 0}>
      <fieldset class="m-0 mb-1.5 flex flex-wrap gap-1 border-0 p-0" aria-label="Show or hide files by label">
        <For each={props.review.labelCounts()}>
          {([label, count]) => {
            const hidden = () => props.review.hiddenLabels().includes(label);
            return (
              <button
                type="button"
                class="cursor-pointer rounded-full border px-1.5 text-[11px] leading-[18px]"
                classList={{
                  "border-line bg-bg text-muted hover:text-fg": !hidden(),
                  "border-line-strong bg-inset text-subtle line-through": hidden(),
                }}
                aria-pressed={!hidden()}
                data-label={label}
                title={hidden() ? `Show the ${count} ${label} files` : `Hide the ${count} ${label} files`}
                onClick={() => props.review.toggleLabel(label)}
              >
                {label} <span class="font-mono text-[10px] text-subtle">{count}</span>
              </button>
            );
          }}
        </For>
      </fieldset>
    </Show>
  );
}

function DiffBar(props: { added: number; removed: number }) {
  const blocks = () => {
    const total = props.added + props.removed;
    // Nothing to count (a rename, a mode change, a binary): neutral blocks.
    if (total === 0) return [0, 1, 2, 3, 4].map(() => "bg-line-strong");
    const add = Math.round((props.added / total) * 5);
    return [0, 1, 2, 3, 4].map((i) => (i < add ? "bg-add" : "bg-del"));
  };
  return (
    <span class="inline-flex gap-px" title={`+${props.added} −${props.removed}`}>
      <For each={blocks()}>{(c) => <i class={`size-[5px] rounded-[1px] ${c}`} />}</For>
    </span>
  );
}
