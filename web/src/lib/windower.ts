/**
 * The arithmetic behind the windowed diff: item heights as prefix sums, so
 * "where does item i start" and "which item is at y" are O(log n) even for
 * 100k items, and one item's height can change (it was measured) in O(log n).
 *
 * Kept free of the DOM so it's easy to test.
 */

/** Heights of a list of items, as a Fenwick (binary indexed) tree over them. */
export class Heights {
  private readonly tree: Float64Array;
  private readonly sizes: Float64Array;

  constructor(sizes: ArrayLike<number>) {
    const n = sizes.length;
    this.sizes = Float64Array.from(sizes);
    // Built in O(n): each node adds itself into its parent.
    this.tree = new Float64Array(n + 1);
    for (let i = 1; i <= n; i++) {
      this.tree[i] = (this.tree[i] as number) + (this.sizes[i - 1] as number);
      const parent = i + (i & -i);
      if (parent <= n) this.tree[parent] = (this.tree[parent] as number) + (this.tree[i] as number);
    }
  }

  get count(): number {
    return this.sizes.length;
  }

  size(i: number): number {
    return this.sizes[i] ?? 0;
  }

  /** Set one item's height; returns how much it changed. */
  set(i: number, h: number): number {
    const delta = h - (this.sizes[i] ?? h);
    if (delta === 0) return 0;
    this.sizes[i] = h;
    for (let j = i + 1; j < this.tree.length; j += j & -j) this.tree[j] = (this.tree[j] as number) + delta;
    return delta;
  }

  /** Where item `i` starts: the sum of the heights before it. */
  offset(i: number): number {
    let sum = 0;
    for (let j = Math.min(i, this.sizes.length); j > 0; j -= j & -j) sum += this.tree[j] as number;
    return sum;
  }

  total(): number {
    return this.offset(this.sizes.length);
  }

  /** The item covering `y` (the last one when `y` is past the end), by descending the tree. */
  indexAt(y: number): number {
    const n = this.sizes.length;
    if (n === 0) return 0;
    let pos = 0;
    let rest = y;
    for (let step = 1 << Math.floor(Math.log2(n)); step > 0; step >>= 1) {
      const next = pos + step;
      if (next <= n && (this.tree[next] as number) <= rest) {
        pos = next;
        rest -= this.tree[next] as number;
      }
    }
    return Math.min(pos, n - 1);
  }
}

/**
 * How many visual lines a line of code wraps to in a column `columns`
 * characters wide (`pre-wrap`, tabs to the next stop). An estimate for lines
 * not measured yet: exact for ASCII in a monospace font, close otherwise.
 */
export function wrappedLines(text: string, columns: number, tabSize = 4): number {
  if (columns <= 0 || text.length <= columns) {
    // Short lines are the common case; only tabs can push them over.
    if (!text.includes("\t")) return 1;
  }
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    width += text.charCodeAt(i) === 9 ? tabSize - (width % tabSize) : 1;
  }
  return Math.max(1, Math.ceil(width / Math.max(1, columns)));
}
