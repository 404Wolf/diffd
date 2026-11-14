/**
 * A Showing board: the files agents put in front of the user (`present`).
 *
 * The tray lists the items; the reader shows the one that's open. Each item
 * can be minimised (it stays in the tray, out of the way) or hidden (it moves
 * to "Hidden", where it can be brought back), and the server keeps that, so
 * a phone and a desktop see the same board. The same component serves every
 * screen; board.css lays it out by the space it has.
 */
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { match } from "ts-pattern";
import type { BoardItem, BoardItemContent, BoardItemKind, BoardItemState } from "../api";
import { boardItem, listBoard, setBoardItemState } from "../api";
import "../board.css";
import { ok } from "../lib/api";
import {
  assetUrl,
  boardPath,
  codeRowsHtml,
  isNew,
  neighbour,
  openFromLocation,
  presenter,
  trayOrder,
} from "../lib/board";
import { highlightCodeBlocks } from "../lib/codeBlocks";
import { renderDocument } from "../lib/document";
import { loadJson, saveJson } from "../lib/storage";
import { ago } from "../lib/time";

/** How often an open board asks for news, while it's on screen. */
const POLL_MS = 30_000;

const KIND_ICON: Record<BoardItemKind, string> = { markdown: "¶", code: "{}", image: "▣", text: "≡" };

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function Board(props: { scope: string | null; items: BoardItem[]; open: BoardItemContent | null }) {
  const [items, setItems] = createSignal<BoardItem[]>(props.items);
  const [openId, setOpenId] = createSignal<string | null>(props.open?.item.id ?? openFromLocation(location));
  const [contents, setContents] = createSignal<ReadonlyMap<string, BoardItemContent>>(
    new Map(props.open ? [[props.open.item.id, props.open]] : []),
  );
  const [showHidden, setShowHidden] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let reader: HTMLElement | undefined;

  const tray = createMemo(() => trayOrder(items()));
  const openItem = createMemo(() => items().find((i) => i.id === openId()) ?? null);
  const content = createMemo(() => {
    const id = openId();
    return (id && contents().get(id)) || null;
  });
  /** The agent presented a newer revision than the one on screen. */
  const stale = createMemo(() => {
    const item = openItem();
    const shown = content();
    return Boolean(item && shown && shown.item.revision < item.revision);
  });
  const newCount = createMemo(() => tray().shown.filter(isNew).length);

  createEffect(() => {
    document.title = `Showing · ${props.scope ?? "all boards"}`;
  });

  const load = async (id: string) => {
    try {
      const loaded = await ok(boardItem({ path: { id } }), "load the item");
      setContents((m) => new Map(m).set(id, loaded));
      setItems((list) => list.map((i) => (i.id === id ? loaded.item : i)));
    } catch (e) {
      setError(errorText(e));
    }
  };

  createEffect(() => {
    const id = openId();
    if (id && !contents().has(id)) void load(id);
  });

  /** Change an item on the server, showing the change at once (and undoing it if the server says no). */
  const change = async (item: BoardItem, what: { state?: BoardItemState; seen?: number }) => {
    const before = items();
    setItems((list) =>
      list.map((i) =>
        i.id === item.id
          ? {
              ...i,
              state: what.state ?? i.state,
              seenRevision: Math.max(i.seenRevision, Math.min(what.seen ?? 0, i.revision)),
            }
          : i,
      ),
    );
    try {
      const saved = await ok(
        setBoardItemState({ path: { id: item.id }, body: { state: what.state ?? null, seen: what.seen ?? null } }),
        "update the item",
      );
      setItems((list) => list.map((i) => (i.id === saved.id ? saved : i)));
    } catch (e) {
      setItems(before);
      setError(errorText(e));
    }
  };

  // Reading an item, in the revision it now has, is seeing it.
  createEffect(() => {
    const item = openItem();
    const shown = content();
    if (item && shown && isNew(item) && shown.item.revision === item.revision) void change(item, { seen: item.revision });
  });

  const open = (item: BoardItem) => {
    if (openId() !== item.id) {
      setOpenId(item.id);
      history.pushState(null, "", boardPath(props.scope, item.id));
      reader?.scrollTo({ top: 0 });
    }
    if (item.state !== "open") void change(item, { state: "open" });
  };
  const close = () => {
    setOpenId(null);
    history.pushState(null, "", boardPath(props.scope, null));
  };
  const putAway = (item: BoardItem, state: "minimised" | "hidden") => {
    if (openId() === item.id) close();
    void change(item, { state });
  };
  const restore = (item: BoardItem) => void change(item, { state: "minimised" });

  const refresh = async () => {
    try {
      const query = props.scope === null ? {} : { scope: props.scope };
      setItems(await ok(listBoard({ query }), "refresh the board"));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const go = (step: 1 | -1) => {
    const next = neighbour(tray().shown, openId(), step);
    if (next) open(next);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if ((e.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]")) return;
    const item = openItem();
    const actions: Record<string, () => void> = {
      j: () => go(1),
      k: () => go(-1),
      m: () => item && putAway(item, "minimised"),
      x: () => item && putAway(item, "hidden"),
      H: () => setShowHidden((v) => !v),
      Escape: () => openId() !== null && close(),
    };
    const action = actions[e.key];
    if (!action) return;
    e.preventDefault();
    action();
  };

  onMount(() => {
    const controller = new AbortController();
    const { signal } = controller;
    window.addEventListener("keydown", onKey, { signal });
    window.addEventListener("popstate", () => setOpenId(openFromLocation(location)), { signal });
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "visible") void refresh();
      },
      { signal },
    );
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    onCleanup(() => {
      controller.abort();
      clearInterval(timer);
    });
  });

  return (
    <div class="board" data-open={openId() === null ? undefined : ""}>
      <header class="board-bar">
        <button type="button" class="board-back" aria-label="Back to the list" onClick={close}>
          ‹
        </button>
        <h1 class="board-title">
          <i class="size-2 flex-none rotate-45 rounded-[2px] bg-accent" />
          Showing
          <span class="scope">· {props.scope ?? "all boards"}</span>
        </h1>
        <Show when={newCount() > 0}>
          <span class="board-count" title="New since you last looked">
            ● {newCount()}
          </span>
        </Show>
      </header>
      <Show when={error()}>
        {(message) => (
          <p class="board-error" role="status">
            {message()}
          </p>
        )}
      </Show>
      <div class="board-body">
        <nav class="board-tray" aria-label="Shown items">
          <Show when={items().length === 0}>
            <p class="board-empty">
              Nothing here yet. Agents put files here with diffd's <code>present</code> tool, or{" "}
              <code>diffd present FILE</code> in a shell.
            </p>
          </Show>
          <ul class="tray-list">
            <For each={tray().shown}>
              {(item) => (
                <TrayRow
                  item={item}
                  current={openId() === item.id}
                  showScope={props.scope === null}
                  onOpen={() => open(item)}
                  actions={
                    <>
                      <Show when={item.state === "open"}>
                        <button
                          type="button"
                          class="icon-btn"
                          title="Minimise (m)"
                          aria-label={`Minimise ${item.title}`}
                          onClick={() => putAway(item, "minimised")}
                        >
                          —
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="icon-btn"
                        title="Hide (x)"
                        aria-label={`Hide ${item.title}`}
                        onClick={() => putAway(item, "hidden")}
                      >
                        ×
                      </button>
                    </>
                  }
                />
              )}
            </For>
          </ul>
          <Show when={tray().hidden.length > 0}>
            <div class="tray-hidden">
              <button
                type="button"
                class="tray-hidden-toggle"
                aria-expanded={showHidden()}
                onClick={() => setShowHidden((v) => !v)}
              >
                {showHidden() ? "▾" : "▸"} Hidden ({tray().hidden.length})
              </button>
              <Show when={showHidden()}>
                <ul class="tray-list">
                  <For each={tray().hidden}>
                    {(item) => (
                      <TrayRow
                        item={item}
                        current={openId() === item.id}
                        showScope={props.scope === null}
                        onOpen={() => open(item)}
                        actions={
                          <button
                            type="button"
                            class="icon-btn"
                            title="Bring back"
                            aria-label={`Bring back ${item.title}`}
                            onClick={() => restore(item)}
                          >
                            ↺
                          </button>
                        }
                      />
                    )}
                  </For>
                </ul>
              </Show>
            </div>
          </Show>
        </nav>
        <main class="board-reader" ref={reader}>
          <Show
            when={openItem()}
            fallback={
              <p class="board-pick">
                {openId() === null ? "Choose an item to read it." : "This item isn't on the board any more."}
              </p>
            }
          >
            {(item) => (
              <Reader
                item={item()}
                content={content()}
                stale={stale()}
                onReload={() => void load(item().id)}
                onMinimise={() => putAway(item(), "minimised")}
                onHide={() => putAway(item(), "hidden")}
              />
            )}
          </Show>
        </main>
      </div>
    </div>
  );
}

function TrayRow(props: {
  item: BoardItem;
  current: boolean;
  showScope: boolean;
  onOpen: () => void;
  actions: JSX.Element;
}) {
  const meta = () =>
    [
      props.showScope ? props.item.scope : null,
      presenter(props.item),
      ago(props.item.updatedAt),
      props.item.message,
    ].filter((x): x is string => Boolean(x));
  return (
    <li class="tray-item" data-state={props.item.state} aria-current={props.current ? "true" : undefined}>
      <button type="button" class="tray-open" onClick={() => props.onOpen()}>
        <span class="tray-line">
          <span class="tray-kind" aria-hidden="true">
            {KIND_ICON[props.item.kind]}
          </span>
          <Show when={isNew(props.item)}>
            <span class="dot" role="img" aria-label="New" />
          </Show>
          <span class="tray-name">{props.item.title}</span>
        </span>
        <span class="tray-meta">
          <span>{meta().join(" · ")}</span>
        </span>
      </button>
      <span class="tray-actions">{props.actions}</span>
    </li>
  );
}

function Reader(props: {
  item: BoardItem;
  content: BoardItemContent | null;
  stale: boolean;
  onReload: () => void;
  onMinimise: () => void;
  onHide: () => void;
}) {
  const meta = () =>
    [
      presenter(props.item),
      ago(props.item.updatedAt),
      props.item.revision > 1 ? `version ${props.item.revision}` : null,
    ].filter((x): x is string => Boolean(x));
  return (
    <article class="reader" aria-labelledby="reader-title">
      <header class="reader-head">
        <h2 id="reader-title" class="reader-title">
          {props.item.title}
        </h2>
        <p class="reader-meta">{meta().join(" · ")}</p>
        <p class="reader-path" title="Where the file was when it was presented">
          {props.item.source.path}
        </p>
        <Show when={props.item.message}>{(message) => <p class="reader-message">{message()}</p>}</Show>
      </header>
      <Show when={props.stale}>
        <button type="button" class="reader-stale" onClick={() => props.onReload()}>
          Updated · show the new version
        </button>
      </Show>
      <div class="reader-body">
        <Show when={props.content} keyed fallback={<p class="board-empty">Loading…</p>}>
          {(shown) => <ItemBody content={shown} />}
        </Show>
      </div>
      <div class="reader-actions" role="toolbar" aria-label="This item">
        <button type="button" title="Minimise (m)" onClick={() => props.onMinimise()}>
          <span aria-hidden="true">— </span>Minimise
        </button>
        <button type="button" title="Hide (x)" onClick={() => props.onHide()}>
          <span aria-hidden="true">× </span>Hide
        </button>
      </div>
    </article>
  );
}

function ItemBody(props: { content: BoardItemContent }) {
  return match(props.content.item.kind)
    .with("markdown", () => <DocumentView content={props.content} />)
    .with("code", "text", () => <CodeView content={props.content} />)
    .with("image", () => <ImageView item={props.content.item} />)
    .exhaustive();
}

function DocumentView(props: { content: BoardItemContent }) {
  let el: HTMLDivElement | undefined;
  const item = props.content.item;
  const html = renderDocument(props.content.text ?? "", {
    assets: item.assets,
    assetUrl: (name) => assetUrl(item, name),
  });
  onMount(() => {
    if (el) highlightCodeBlocks(el);
  });
  return <div ref={el} class="doc" innerHTML={html} />;
}

const WRAP_KEY = "diffd.board.wrap";

function CodeView(props: { content: BoardItemContent }) {
  const { item, text, syntax, totalLines } = props.content;
  // Plain text reads best wrapped; code keeps its lines unless asked.
  const [wrap, setWrap] = createSignal(item.kind === "text" || loadJson(WRAP_KEY, false));
  const lit = item.lines && item.lines.length === 2 ? ([item.lines[0], item.lines[1]] as [number, number]) : null;
  const html = codeRowsHtml(text ?? "", syntax, { language: item.language, lit });
  let el: HTMLDivElement | undefined;
  onMount(() => {
    if (lit && el) el.querySelector(`[data-line="${lit[0]}"]`)?.scrollIntoView({ block: "center" });
  });
  const toggle = () => {
    const next = !wrap();
    setWrap(next);
    if (item.kind === "code") saveJson(WRAP_KEY, next);
  };
  return (
    <div>
      <div class="code-tools">
        <span>{item.language ?? "Text"}</span>
        <Show when={lit}>{(range) => <span>lines {`${range()[0]}–${range()[1]}`}</span>}</Show>
        <button type="button" aria-pressed={wrap()} onClick={toggle}>
          Wrap lines
        </button>
      </div>
      <div ref={el} class="board-code" classList={{ wrap: wrap() }} innerHTML={html} />
      <Show when={totalLines}>
        {(total) => <p class="code-cut">Showing the first 5,000 of {total().toLocaleString()} lines.</p>}
      </Show>
    </div>
  );
}

function ImageView(props: { item: BoardItem }) {
  const url = () => assetUrl(props.item, "");
  return (
    <a class="board-image" href={url()} target="_blank" rel="noopener noreferrer" title="Open on its own">
      <img src={url()} alt={props.item.title} />
    </a>
  );
}
