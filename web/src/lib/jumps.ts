/**
 * A vim-style jump list. `push` records where you were before a jump; `back`
 * and `forward` walk the list, and the current place is remembered so you
 * can return to it.
 */
export class JumpList<T> {
  private list: T[] = [];
  private at = 0;

  constructor(private readonly limit = 100) {}

  push(here: T): void {
    this.list = this.list.slice(0, this.at);
    this.list.push(here);
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

  get position(): { at: number; length: number } {
    return { at: this.at, length: this.list.length };
  }
}
