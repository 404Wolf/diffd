/**
 * What the page calls the agent: its harness's name ("Claude", "Codex"), as
 * the server learned it when the review was shared. One review per page, so
 * one name.
 */
import { createSignal } from "solid-js";

const [name, setName] = createSignal("Agent");

/** The agent's name, e.g. "Codex". Reactive. */
export const agentName = name;

export function setAgentName(agent: string | null): void {
  setName(agent?.trim() || "Agent");
}
