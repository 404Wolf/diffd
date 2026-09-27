import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { createStore } from "solid-js/store";
import type { FileDiff } from "../gen/FileDiff";
import { STATUS } from "../lib/status";
import { buildTree, parentDir, type TreeNode } from "../lib/tree";
import type { Commands } from "../state/commands";
import type { Review } from "../state/review";
import type { View } from "../state/view";

/** GitHub-style changed-files tree: compact folders, status, a five-block +/− bar. */
export function FileTree(props: { review: Review; view: View; cmd: Commands; current: () => number | null }) {
  const [filter, setFilter] = createSignal("");
  const [closed, setClosed] = createStore<Record<string, boolean>>({});
  /** Folders whose other files (not in the diff) are listed too. */
  const [neighbours, setNeighbours] = createStore<Record<string, boolean>>({});
  const showNeighbours = (dir: string, on: boolean) => {
    if (on) props.review.loadRepoFiles();
    setNeighbours(dir, on);
  };
  const extra = createMemo(() => (props.review.repoFiles() ?? []).filter((p) => neighbours[parentDir(p)]));
  const tree = createMemo(() => buildTree(props.review.paths(), filter(), extra()));
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

  const Node = (p: { node: TreeNode }) => (
    <Switch>
      <Match when={p.node.kind === "dir" && p.node}>
        {(dir) => (
          <li>
            <div class="group flex items-center rounded hover:bg-hover">
              <button
                type="button"
                class="flex h-5 min-w-0 flex-1 cursor-pointer items-center gap-1 px-1 text-left text-[12.5px] whitespace-nowrap text-muted"
                aria-expanded={!closed[dir().path]}
                onClick={() => setClosed(dir().path, (c) => !c)}
              >
                <span
                  class="w-3 flex-none text-center text-[8px] text-subtle transition-transform"
                  classList={{ "-rotate-90": closed[dir().path] }}
                >
                  ▼
                </span>
                <span class="truncate">{dir().name}</span>
              </button>
              <button
                type="button"
                class="mr-0.5 flex-none cursor-pointer rounded px-1 text-[11px] leading-4 text-subtle hover:bg-bg hover:text-fg"
                classList={{
                  "invisible group-hover:visible": !neighbours[dir().path],
                  "text-accent": neighbours[dir().path],
                }}
                title={
                  neighbours[dir().path] ? "Hide files not in the diff" : "Show every file in this folder"
                }
                aria-label={`Other files in ${dir().path}`}
                aria-pressed={Boolean(neighbours[dir().path])}
                onClick={() => showNeighbours(dir().path, !neighbours[dir().path])}
              >
                ⋯
              </button>
            </div>
            <Show when={!closed[dir().path]}>
              <ul class="ml-2.5 border-l border-line pl-[3px]">
                <For each={dir().children}>{(child) => <Node node={child} />}</For>
              </ul>
            </Show>
          </li>
        )}
      </Match>
      <Match when={p.node.kind === "file" && p.node.index < 0 && p.node}>
        {(f) => (
          // A neighbour: in the repository, not in the diff. Opening it fetches it.
          <li>
            <button
              type="button"
              class="flex h-5 w-full cursor-pointer items-center gap-1.5 rounded px-1 text-left text-[12.5px] whitespace-nowrap text-subtle italic hover:bg-hover hover:text-fg"
              title={`${f().path} · not changed; open to read or comment`}
              data-neighbour={f().path}
              onClick={() => void props.cmd.openPath(f().path)}
            >
              <span class="w-3 flex-none" />
              <span class="min-w-0 flex-1 truncate">{f().name}</span>
            </button>
          </li>
        )}
      </Match>
      <Match when={p.node.kind === "file" && p.node}>
        {(f) => {
          const file = () => props.review.snapshot().files[f().index] as FileDiff;
          const { letter, color } = STATUS[file().status];
          return (
            <li>
              <button
                type="button"
                class="flex h-5 w-full cursor-pointer items-center gap-1.5 rounded px-1 text-left text-[12.5px] whitespace-nowrap hover:bg-hover"
                classList={{ "bg-accent-soft": props.current() === f().index }}
                aria-current={props.current() === f().index}
                data-tree-file={f().path}
                data-context={props.review.isContext(f().index) ? "" : undefined}
                title={`${f().path}${file().collapsed ? ` · collapsed: ${file().collapsed}` : ""}`}
                onClick={() => {
                  props.cmd.openFile(f().index);
                  // Opening a file shows what else is in its folder.
                  showNeighbours(parentDir(f().path), true);
                }}
              >
                <span
                  class={`w-3 flex-none text-center font-mono text-[10px] font-semibold ${props.view.flags.viewed[f().path] ? "text-subtle" : color}`}
                >
                  {props.view.flags.viewed[f().path] ? "✓" : letter}
                </span>
                <span
                  class="min-w-0 flex-1 truncate"
                  classList={{ "text-subtle": props.view.hidden(f().index) }}
                >
                  {f().name}
                </span>
                <span class="flex items-center gap-1.5 font-mono text-[10.5px] text-subtle">
                  <Show when={unreadFiles().has(f().path)}>
                    <span class="size-1.5 rounded-full bg-accent" title="Unread reply" />
                  </Show>
                  <Show when={threadCount(f().path) > 0}>
                    <span
                      classList={{ "font-semibold text-accent": unreadFiles().has(f().path) }}
                      title="Threads"
                    >
                      ◆{threadCount(f().path)}
                    </span>
                  </Show>
                  <Show when={problems(f().path)}>
                    {(p) => (
                      <span
                        data-problems={f().path}
                        classList={{ "text-del": p().errors > 0, "text-warn": p().errors === 0 }}
                        title={`${p().errors} errors, ${p().warnings} warnings`}
                      >
                        {p().errors > 0 ? `✖${p().errors}` : `▲${p().warnings}`}
                      </span>
                    )}
                  </Show>
                  <DiffBar added={file().added} removed={file().removed} />
                </span>
              </button>
            </li>
          );
        }}
      </Match>
    </Switch>
  );

  return (
    <nav aria-label="Changed files">
      <div class="sticky top-0 z-[2] bg-panel px-2 pt-1.5 pb-1">
        <div class="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold tracking-wider text-muted uppercase">
          Files <span class="font-medium tracking-normal text-subtle">{props.review.diffCount()}</span>
        </div>
        <input
          type="search"
          placeholder="Filter files"
          aria-label="Filter files"
          autocomplete="off"
          class="h-6 w-full rounded border border-line bg-bg px-2 text-xs"
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
      </div>
      <ul class="px-1.5 pb-2.5">
        <For each={tree()}>{(node) => <Node node={node} />}</For>
      </ul>
    </nav>
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
