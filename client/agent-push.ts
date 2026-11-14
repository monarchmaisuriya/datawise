import type { AgentTabsEvent, AgentViewEvent, ObjectRef, QueryTabs } from "../shared/contracts";

const tabsListeners = new Set<(event: AgentTabsEvent) => void>();
const viewListeners = new Set<(event: AgentViewEvent) => void>();

// An agent's change to tabs or a view, passed to the open query workspaces and data tabs it is about.
export function receiveAgentChange(event: AgentTabsEvent | AgentViewEvent): void {
  if (event.kind === "tabs") for (const listener of tabsListeners) listener(event);
  else for (const listener of viewListeners) listener(event);
}

export function onAgentTabs(listener: (event: AgentTabsEvent) => void): () => void {
  tabsListeners.add(listener);
  return () => tabsListeners.delete(listener);
}

export function onAgentView(listener: (event: AgentViewEvent) => void): () => void {
  viewListeners.add(listener);
  return () => viewListeners.delete(listener);
}

export function sameObject(left: ObjectRef, right: ObjectRef): boolean {
  return left.connectionId === right.connectionId && (left.database ?? null) === (right.database ?? null) && (left.schema ?? null) === (right.schema ?? null) && left.name === right.name;
}

// Applies an agent's renames and closes to a window's own tabs. A tab closes only while its text is still what the
// server saw, so anything typed since keeps it; the last tab is never closed.
export function applyAgentTabs(state: QueryTabs, event: AgentTabsEvent): QueryTabs {
  const names = new Map(event.renamed.map((item) => [item.id, item.name]));
  const closing = new Map(event.closed.map((item) => [item.id, item.text]));
  const tabs = state.tabs.filter((tab) => !(closing.has(tab.id) && closing.get(tab.id) === tab.text)).map((tab) => (names.has(tab.id) ? { ...tab, name: names.get(tab.id) as string } : tab));
  if (tabs.length === 0) return state;
  return { activeId: tabs.some((tab) => tab.id === state.activeId) ? state.activeId : (tabs[0] as { id: string }).id, tabs };
}
