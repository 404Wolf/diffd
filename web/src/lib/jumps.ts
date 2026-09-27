/**
 * A vim-style jump list. `push` records where you were before a jump; `back`
 * and `forward` walk the list, and the current place is remembered so you
 * can return to it.
 */
export class JumpList<T> {
  private list: T[] = [];
  private at = 0;

  /** `same`: whether two places are one, so jumping from the same place twice is one entry. */
  constructor(
    private readonly limit = 100,
    private readonly same: (a: T, b: T) => boolean = Object.is,
  ) {}

  push(here: T): void {
    this.list = this.list.slice(0, this.at);
    const last = this.list.at(-1);
    if (last === undefined || !this.same(last, here)) this.list.push(here);
    if (this.list.length > this.limit) this.list.shift();
    this.at = this.list.length;
  }

  back(here: T): T | null {
    if (this.at === 0) return null;
    if (this.at === this.list.length) this.list.push(here);
    this.at--;
    return this.list[this.at] ?? null;
  }

  forward(): T | null {
    if (this.at >= this.list.length - 1) return null;
    this.at++;
    return this.list[this.at] ?? null;
  }

  /** Rewrite every entry (e.g. when files moved); entries mapped to null are dropped. */
  remap(f: (entry: T) => T | null): void {
    const before = this.list
      .slice(0, this.at)
      .map(f)
      .filter((e): e is T => e !== null);
    const after = this.list
      .slice(this.at)
      .map(f)
      .filter((e): e is T => e !== null);
    this.list = [...before, ...after];
    this.at = before.length;
  }

  get position(): { at: number; length: number } {
    return { at: this.at, length: this.list.length };
  }
}
