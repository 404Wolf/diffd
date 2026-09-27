/**
 * Preferences kept in localStorage. Storage can be unavailable (a private
 * window, blocked site data): then reads give the fallback and writes are
 * dropped, so a preference just doesn't persist.
 */

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not remembered, then.
  }
}
