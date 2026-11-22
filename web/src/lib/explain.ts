/**
 * The agent's explanation of a change, as the rows the review shows at its top.
 */
import type { Explanation } from "../api";

export interface ExplainRow {
  readonly label: string;
  /** Markdown; `null` for a part the agent left out that the reader should know is missing. */
  readonly text: string | null;
}

const PARTS = [
  ["whatChanged", "What changed"],
  ["before", "Before"],
  ["after", "After"],
  ["why", "Why"],
  ["verification", "Verification"],
] as const;

/**
 * The parts the agent filled, in the template's order. A missing Verification
 * stays as a row saying so, since "nothing was checked" matters to a reviewer;
 * other missing parts are left out. No explanation (older reviews) is no rows.
 */
export function explainRows(e: Partial<Explanation> | null | undefined): ExplainRow[] {
  if (!e) return [];
  const rows: ExplainRow[] = [];
  for (const [key, label] of PARTS) {
    const text = e[key]?.trim();
    if (text) rows.push({ label, text });
    else if (key === "verification") rows.push({ label, text: null });
  }
  return rows.length === 1 && rows[0]?.text === null ? [] : rows;
}
