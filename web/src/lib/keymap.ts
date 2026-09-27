import { match } from "ts-pattern";

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

/** An input method (Japanese, Chinese, …) is composing text: its keys aren't ours. */
export function composing(e: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  // keyCode 229 is how some browsers mark the key that starts a composition.
  return e.isComposing || e.keyCode === 229;
}

/** Normalize a keyboard event to a token, or null for keys we never bind. */
export function keyToken(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
): string | null {
  // Cmd+F is find on macOS, as Ctrl+F is elsewhere: both open the page's own search.
  if (e.metaKey) return e.key === "f" ? "ctrl-f" : null;
  if (e.altKey) {
    // AltGr (which Windows reports as Ctrl+Alt) and macOS Option type `[ ] { } \`
    // on many keyboard layouts: take the character they typed. Alt with a
    // letter or digit is a browser or OS shortcut, not ours.
    return e.key.length === 1 && !/[\p{L}\p{N}]/u.test(e.key) ? e.key : null;
  }
  return (
    match(e.key)
      .with(" ", () => (e.ctrlKey ? null : "space"))
      .with("Enter", () => `${e.ctrlKey ? "ctrl-" : ""}${e.shiftKey ? "shift-" : ""}enter`)
      .with("Escape", () => (e.ctrlKey ? "ctrl-esc" : "esc"))
      .with("Tab", () => (e.shiftKey || e.ctrlKey ? null : "tab"))
      .with("ArrowDown", () => "down")
      .with("ArrowUp", () => "up")
      // Other named keys (F1, Home, …) aren't bound.
      .when(
        (key) => key.length !== 1,
        () => null,
      )
      .otherwise((key) => (e.ctrlKey ? `ctrl-${key.toLowerCase()}` : key))
  );
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
