/**
 * The page's WebSocket to the server. Messages are the generated protocol
 * types; sends made while disconnected wait in an outbox and go out on
 * reconnect, so comments written offline aren't lost.
 */
import type { ClientMsg } from "../gen/ClientMsg";
import type { ServerMsg } from "../gen/ServerMsg";

export type Connection = "connecting" | "live" | "offline";

export interface Socket {
  send(msg: ClientMsg): void;
  close(): void;
}

export function connect(
  reviewId: string,
  onMessage: (msg: ServerMsg) => void,
  onStatus: (status: Connection) => void,
): Socket {
  const key = `diffd:outbox:${reviewId}`;
  const outbox: ClientMsg[] = loadOutbox(key);
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 500;

  const save = () => {
    try {
      localStorage.setItem(key, JSON.stringify(outbox));
    } catch {
      // Storage can be unavailable (private mode); the outbox still lives in memory.
    }
  };

  const flush = () => {
    while (ws?.readyState === WebSocket.OPEN && outbox.length > 0) {
      ws.send(JSON.stringify(outbox.shift()));
    }
    save();
  };

  const open = () => {
    if (closed || location.protocol === "file:") {
      onStatus("offline");
      return;
    }
    onStatus("connecting");
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${scheme}://${location.host}/api/reviews/${encodeURIComponent(reviewId)}/ws`);
    ws.onopen = () => {
      delay = 500;
      onStatus("live");
      flush();
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(String(e.data)) as ServerMsg);
      } catch (err) {
        console.error("diffd: bad message from server", err);
      }
    };
    ws.onclose = () => {
      ws = null;
      if (closed) return;
      onStatus("offline");
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 10_000);
    };
  };
  open();

  return {
    send(msg) {
      outbox.push(msg);
      flush();
    },
    close() {
      closed = true;
      ws?.close();
    },
  };
}

function loadOutbox(key: string): ClientMsg[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as ClientMsg[]) : [];
  } catch {
    return [];
  }
}
