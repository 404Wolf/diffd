import { createEffect, For, onCleanup, Show } from "solid-js";
import type { Commands } from "../state/commands";
import { bufferEl } from "../state/dom";

export interface MenuAt {
  readonly x: number;
  readonly y: number;
  /** The symbol right-clicked on, if any (for the labels). */
  readonly word: string | null;
}

interface Item {
  readonly label: string;
  readonly keys: string;
  readonly run: (cmd: Commands) => void;
  /** Only for a symbol. */
  readonly symbol?: boolean;
}

const ITEMS: readonly Item[] = [
  { label: "Go to definition", keys: "g d", run: (c) => void c.gotoDefinition(), symbol: true },
  { label: "Go to type definition", keys: "g t", run: (c) => void c.typeDefinition(), symbol: true },
  { label: "Find references", keys: "g r r", run: (c) => c.references(), symbol: true },
  { label: "Docs and errors", keys: "K", run: (c) => void c.hoverAtCursor() },
  { label: "Comment on this line", keys: "g c c", run: (c) => c.comment() },
  { label: "Open the file in a split", keys: "g space", run: (c) => c.fileInSplit() },
];

/**
 * The right-click menu on code: the cursor is already on what was clicked,
 * so each item is the same command as its keys. Arrow keys move, enter picks,
 * escape (or a click anywhere else) closes it.
 */
export function ContextMenu(props: { at: MenuAt | null; cmd: Commands; onClose: () => void }) {
  let menu: HTMLDivElement | undefined;
  const items = () => ITEMS.filter((i) => !i.symbol || props.at?.word);
  const close = (refocus: boolean) => {
    props.onClose();
    if (refocus) bufferEl()?.focus({ preventScroll: true });
  };
  const pick = (item: Item) => {
    close(true);
    item.run(props.cmd);
  };
  createEffect(() => {
    if (!props.at) return;
    // Open on the first item, and inside the window.
    queueMicrotask(() => {
      if (!menu) return;
      const r = menu.getBoundingClientRect();
      menu.style.left = `${Math.min(props.at?.x ?? 0, window.innerWidth - r.width - 4)}px`;
      menu.style.top = `${Math.min(props.at?.y ?? 0, window.innerHeight - r.height - 4)}px`;
      menu.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    });
    const away = (e: Event) => {
      if (!menu?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("blur", () => close(false), { once: true });
    onCleanup(() => document.removeEventListener("pointerdown", away, true));
  });
  const onKeyDown = (e: KeyboardEvent) => {
    const all = [...(menu?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "j") all[(at + 1) % all.length]?.focus();
    else if (e.key === "ArrowUp" || e.key === "k") all[(at - 1 + all.length) % all.length]?.focus();
    else if (e.key === "Escape") close(true);
    else return;
    e.preventDefault();
  };
  return (
    <Show when={props.at}>
      {(at) => (
        <div
          ref={menu}
          role="menu"
          aria-label={at().word ? `Actions for ${at().word}` : "Actions for this line"}
          class="fixed z-50 min-w-56 rounded-md border border-line-strong bg-bg py-1 text-[12.5px] shadow-pop"
          style={{ left: `${at().x}px`, top: `${at().y}px` }}
          onKeyDown={onKeyDown}
        >
          <Show when={at().word}>
            {(word) => (
              <div class="truncate px-3 pt-0.5 pb-1 font-mono text-[11.5px] text-muted">{word()}</div>
            )}
          </Show>
          <For each={items()}>
            {(item) => (
              <button
                type="button"
                role="menuitem"
                class="flex w-full cursor-pointer items-center justify-between gap-6 px-3 py-1 text-left hover:bg-hover focus:bg-hover focus:outline-none"
                onClick={() => pick(item)}
              >
                <span>{item.label}</span>
                <kbd class="text-[11px] text-subtle">{item.keys}</kbd>
              </button>
            )}
          </For>
        </div>
      )}
    </Show>
  );
}
