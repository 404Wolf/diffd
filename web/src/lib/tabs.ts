/**
 * Several tabs can have the same review open. Each tab has an id that
 * survives reloads (sessionStorage) and holds a Web Lock named after it for
 * as long as it's open, so other tabs can tell which ids belong to closed
 * tabs (and pick up anything those left unsent).
 */

const KEY = "diffd:tab";
const lockName = (id: string) => `diffd-tab:${id}`;

type Locks = {
  request(
    name: string,
    opts: { ifAvailable: boolean },
    cb: (lock: unknown) => Promise<void> | void,
  ): Promise<void>;
  query(): Promise<{ held?: { name?: string }[] }>;
};
const locks = (): Locks | null => (navigator as unknown as { locks?: Locks }).locks ?? null;

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

let current: Promise<string> | null = null;

/** This tab's id, claimed with a lock. A duplicated tab (same sessionStorage) gets a new one. */
export function tabId(): Promise<string> {
  current ??= claim();
  return current;
}

async function claim(): Promise<string> {
  let id = readId() ?? randomId();
  const l = locks();
  if (!l) {
    writeId(id);
    return id;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const got = await new Promise<boolean>((resolve) => {
      l.request(lockName(id), { ifAvailable: true }, (lock) => {
        resolve(lock !== null);
        // Hold it until the tab goes away.
        return lock === null ? undefined : new Promise<void>(() => {});
      }).catch(() => resolve(false)); // Locks unavailable here (e.g. an opaque origin).
    });
    if (got) break;
    id = randomId();
  }
  writeId(id);
  return id;
}

/** Ids of tabs that are open right now, or null when the browser can't tell. */
export async function liveTabs(): Promise<Set<string> | null> {
  const l = locks();
  if (!l) return null;
  const { held = [] } = await l.query().catch(() => ({ held: undefined }));
  return new Set(
    held.flatMap((h) => (h.name?.startsWith("diffd-tab:") ? [h.name.slice("diffd-tab:".length)] : [])),
  );
}

function readId(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function writeId(id: string): void {
  try {
    sessionStorage.setItem(KEY, id);
  } catch {
    // Without sessionStorage a reload gets a new id; its unsent messages are adopted like a closed tab's.
  }
}
