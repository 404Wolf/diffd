/**
 * A small vim-style key-sequence engine. Bindings are plain data; the engine
 * handles counts (`5j`), multi-key sequences (`g d`, `] c`) and modes.
 */

export type Mode = "normal" | "visual" | "symbol" | "file";

export interface Binding<C> {
  /** Space-separated key tokens, e.g. `"g d"`, `"ctrl-o"`, `"space e"`. */
  readonly keys: string;
  /** Modes it applies in; all modes when omitted. */
  readonly modes?: readonly Mode[];
  readonly run: (ctx: C, count: number) => void;
  /** Where it appears in the help screen: [group, description]. */
  readonly help?: readonly [group: string, label: string];
}

export type Feed =
  | { readonly kind: "ran" }
  | { readonly kind: "pending"; readonly display: string }
  | { readonly kind: "unbound" };

/** Normalize a keyboard event to a token, or null for keys we never bind. */
export function keyToken(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
): string | null {
  if (e.metaKey || e.altKey) return null;
  switch (e.key) {
    case " ":
      return e.ctrlKey ? null : "space";
    case "Enter":
      return e.shiftKey ? "shift-enter" : "enter";
    case "Escape":
      return "esc";
    case "Tab":
      return e.shiftKey || e.ctrlKey ? null : "tab";
    case "ArrowDown":
      return "down";
    case "ArrowUp":
      return "up";
  }
  if (e.key.length !== 1) return null;
  return e.ctrlKey ? `ctrl-${e.key.toLowerCase()}` : e.key;
}

export class KeyEngine<C> {
  private pending: string[] = [];
  private count = "";

  constructor(private readonly bindings: readonly Binding<C>[]) {}

  private candidates(mode: Mode): Binding<C>[] {
    return this.bindings.filter((b) => b.modes === undefined || b.modes.includes(mode));
  }

  /** What the status line should show while a sequence is in progress. */
  display(): string {
    return [this.count, ...this.pending].filter(Boolean).join(" ");
  }

  reset(): void {
    this.pending = [];
    this.count = "";
  }

  feed(token: string, mode: Mode, ctx: C): Feed {
    if (this.pending.length === 0 && (/^[1-9]$/.test(token) || (this.count !== "" && /^\d$/.test(token)))) {
      this.count += token;
      return { kind: "pending", display: this.display() };
    }
    const seq = [...this.pending, token].join(" ");
    const bindings = this.candidates(mode);
    // Mode-specific bindings win over global ones with the same keys.
    const exact =
      bindings.find((b) => b.keys === seq && b.modes !== undefined) ?? bindings.find((b) => b.keys === seq);
    const longer = bindings.some((b) => b.keys.startsWith(`${seq} `));
    if (exact && !longer) {
      const count = Math.max(1, Number.parseInt(this.count || "1", 10));
      this.reset();
      exact.run(ctx, count);
      return { kind: "ran" };
    }
    if (longer || exact) {
      this.pending.push(token);
      return { kind: "pending", display: this.display() };
    }
    // Not a continuation: drop the sequence and try the key on its own.
    const hadPending = this.pending.length > 0;
    this.reset();
    if (hadPending) return this.feed(token, mode, ctx);
    return { kind: "unbound" };
  }

  /**
   * The sequence timed out. If what was typed is itself a binding (e.g. `g c`
   * that could have become `g c c`), run it.
   */
  flush(mode: Mode, ctx: C): boolean {
    const seq = this.pending.join(" ");
    const count = Math.max(1, Number.parseInt(this.count || "1", 10));
    this.reset();
    const b = this.candidates(mode).find((x) => x.keys === seq);
    if (!b) return false;
    b.run(ctx, count);
    return true;
  }
}
