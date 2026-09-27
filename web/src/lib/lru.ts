/** A map that keeps only the `limit` most recently used entries. */
export class Lru<K, V> {
  readonly #entries = new Map<K, V>();

  constructor(readonly limit: number) {}

  /** The value for `key`, which is now the most recently used. */
  get(key: K): V | undefined {
    const value = this.#entries.get(key);
    if (value !== undefined) {
      this.#entries.delete(key);
      this.#entries.set(key, value);
    }
    return value;
  }

  /** Set `key`, dropping the least recently used entry when there are too many. */
  set(key: K, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.limit) break;
      this.#entries.delete(oldest);
    }
  }

  /** The value for `key` without making it the most recently used. */
  peek(key: K): V | undefined {
    return this.#entries.get(key);
  }

  delete(key: K): void {
    this.#entries.delete(key);
  }

  /** Drop every entry whose key matches. */
  deleteWhere(matches: (key: K) => boolean): void {
    for (const key of [...this.#entries.keys()]) if (matches(key)) this.#entries.delete(key);
  }

  get size(): number {
    return this.#entries.size;
  }
}
