/**
 * The page's WebSocket to the server.
 *
 * Comments, replies and chat carry ids the page makes up, and stay in an
 * outbox (mirrored to localStorage) until the server acks that id. Anything
 * written offline, or lost with a dropped connection, is sent again when the
 * page reconnects; the server ignores ids it has already stored, so resending
 * is always safe. Other messages only matter while connected: the latest
 * resolve per thread and the read watermark are kept, drafting is dropped.
 *
 * Each tab has its own outbox (tabs mustn't overwrite each other's). When a
 * tab closes with messages still unsent, the next tab to connect adopts them;
 * if two do at once, the server's idempotency makes the double send harmless.
 */
import { match } from "ts-pattern";
import type { ClientMsg } from "../gen/ClientMsg";
import type { ServerMsg } from "../gen/ServerMsg";
import { liveTabs, tabId } from "./tabs";

/** `gone`: the review was deleted; nothing more will be sent or received. */
export type Connection = "connecting" | "live" | "offline" | "gone";

export interface SocketEvents {
  onMessage: (msg: ServerMsg) => void;
  onStatus: (status: Connection) => void;
  /** The outbox changed: everything written but not yet confirmed, oldest first. */
  onOutbox: (pending: ClientMsg[]) => void;
}

export interface Socket {
  send(msg: ClientMsg): void;
  close(): void;
}

/** Which outbox entry a message replaces, or null when it's never queued. */
function outboxKey(msg: ClientMsg): string | null {
  return (
    match(msg)
      .with({ type: "comment" }, { type: "reply" }, { type: "chat" }, (m) => `m:${m.messageId}`)
      .with({ type: "resolve" }, (m) => `resolve:${m.threadId}`)
      .with({ type: "read" }, () => "read")
      // Live-only: a stale draft flag or an old question is worth nothing after a reconnect.
      .with({ type: "drafting" }, { type: "code" }, () => null)
      .exhaustive()
  );
}

/** Whether an entry waits for an ack, rather than leaving once it's sent. */
const needsAck = (msg: ClientMsg) => msg.type === "comment" || msg.type === "reply" || msg.type === "chat";

const MIN_DELAY = 500;
const MAX_DELAY = 8_000;

export function connect(reviewId: string, events: SocketEvents): Socket {
  const prefix = `diffd:outbox:${reviewId}`;
  /** Known once this tab's id is claimed; until then the outbox lives in memory only. */
  let storageKey: string | null = null;
  const outbox = new Map<string, ClientMsg>();
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let delay = MIN_DELAY;

  const changed = () => {
    try {
      if (storageKey === null) {
        // Not saved yet: the tab id is still being claimed.
      } else if (outbox.size === 0) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify([...outbox]));
    } catch {
      // Storage can be unavailable (private mode, quota); the outbox still lives in memory.
    }
    events.onOutbox([...outbox.values()].filter(needsAck));
  };

  const live = () => ws?.readyState === WebSocket.OPEN;

  const transmit = (key: string | null, msg: ClientMsg) => {
    ws?.send(JSON.stringify(msg));
    if (key !== null && !needsAck(msg)) outbox.delete(key);
  };

  /** Sends the whole outbox, in the order it was written. */
  const flush = () => {
    if (!live()) return;
    for (const [key, msg] of [...outbox]) transmit(key, msg);
    changed();
  };

  const open = () => {
    clearTimeout(retry);
    retry = undefined;
    if (closed || ws !== null) return;
    if (location.protocol === "file:") {
      events.onStatus("offline");
      return;
    }
    events.onStatus("connecting");
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${scheme}://${location.host}/api/reviews/${encodeURIComponent(reviewId)}/ws`,
    );
    ws = socket;
    socket.onopen = () => {
      delay = MIN_DELAY;
      events.onStatus("live");
      flush();
      void adopt();
    };
    socket.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch (err) {
        console.error("diffd: bad message from server", err);
        return;
      }
      if (msg.type === "ack") {
        if (outbox.delete(`m:${msg.id}`)) changed();
        return;
      }
      events.onMessage(msg);
      if (msg.type === "gone") {
        // Nothing queued can be delivered now; stop for good.
        stop();
        outbox.clear();
        changed();
        events.onStatus("gone");
      }
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      if (closed) return;
      events.onStatus("offline");
      retry = setTimeout(open, delay);
      delay = Math.min(delay * 2, MAX_DELAY);
    };
  };

  /** Skip the backoff when there's reason to think the server is reachable again. */
  const nudge = () => {
    if (closed || ws !== null || document.visibilityState === "hidden") return;
    delay = MIN_DELAY;
    open();
  };
  window.addEventListener("online", nudge);
  window.addEventListener("focus", nudge);
  document.addEventListener("visibilitychange", nudge);

  /** Take over outboxes that closed tabs left behind (and the pre-tab one, from older versions). */
  const adopt = async () => {
    const live = await liveTabs();
    let took = false;
    for (const key of storageKeys()) {
      if (key === storageKey || !(key === prefix || key.startsWith(`${prefix}:`))) continue;
      const tab = key.slice(prefix.length + 1);
      if (key !== prefix && (live === null || live.has(tab))) continue;
      for (const [k, msg] of load(key)) if (!outbox.has(k)) outbox.set(k, msg);
      removeKey(key);
      took = true;
    }
    if (took) {
      changed();
      flush();
    }
  };

  void tabId().then((tab) => {
    storageKey = `${prefix}:${tab}`;
    // This tab's own outbox, from before a reload, goes first; then anything written since.
    const mine = new Map(load(storageKey));
    for (const [k, msg] of outbox) mine.set(k, msg);
    outbox.clear();
    for (const [k, msg] of mine) outbox.set(k, msg);
    changed();
    flush();
    void adopt();
  });
  function stop() {
    closed = true;
    clearTimeout(retry);
    window.removeEventListener("online", nudge);
    window.removeEventListener("focus", nudge);
    document.removeEventListener("visibilitychange", nudge);
    ws?.close();
  }

  events.onOutbox([]);
  open();

  return {
    send(msg) {
      const key = outboxKey(msg);
      if (key !== null) {
        outbox.set(key, msg);
        changed();
      }
      if (live()) {
        transmit(key, msg);
        if (key !== null && !needsAck(msg)) changed();
      }
    },
    close: stop,
  };
}

function storageKeys(): string[] {
  try {
    return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "");
  } catch {
    return [];
  }
}

function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing to clean up without storage.
  }
}

function load(key: string): [string, ClientMsg][] {
  try {
    const raw = localStorage.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as [string, ClientMsg][]) : [];
  } catch {
    return [];
  }
}
