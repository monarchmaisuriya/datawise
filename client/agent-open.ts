import { visibleValue } from "../shared/agent-display";
import { AGENT_OPEN_KEPT_MS, type AgentOpenEvent } from "../shared/contracts";

// The last request per workspace, until that workspace's Datawise tab takes it. The tab may mount only after
// openPanel, which runs after the request has arrived, so a listener alone would miss it.
const waiting = new Map<string, { event: AgentOpenEvent; at: number }>();
const listeners = new Set<() => void>();

// Returns whether to bring the tab forward. A production request moves no window: the question waits in the
// workspace's Datawise tab, because Paseo offers a plugin no way to ask before a panel opens.
export function receiveAgentOpen(event: AgentOpenEvent): boolean {
  waiting.set(event.workspaceId, { event, at: Date.now() });
  for (const listener of listeners) listener();
  return event.production === null;
}

export function takeAgentOpen(workspaceId: string): AgentOpenEvent | null {
  const entry = waiting.get(workspaceId);
  waiting.delete(workspaceId);
  return entry && Date.now() - entry.at <= AGENT_OPEN_KEPT_MS ? entry.event : null;
}

export function onAgentOpen(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The agent names itself, so its words are shown as codes, as everywhere else an agent's text is shown.
export function productionQuestion(event: AgentOpenEvent): string {
  const asking = `${visibleValue(event.production?.agentTitle ?? "An agent")} wants to open ${visibleValue(event.production?.connectionName ?? "")}.`;
  return event.text === null ? asking : `${asking} It also puts query text in a tab; nothing runs.`;
}
