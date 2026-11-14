import { visibleText } from "../shared/agent-display";
import { DESTINATION_FIELDS } from "../shared/connection-destination";
import type { ConnectionProposal, ConnectionView } from "../shared/contracts";

const text = (value: unknown) => (value === null || value === undefined || value === "" ? "(none)" : typeof value === "object" ? JSON.stringify(value) : String(value));

// What the form says above an agent's proposal: each proposed value and the one it replaces, the host first,
// because a password typed into this form goes to that host.
export function proposalNote(values: ConnectionProposal, connection: ConnectionView | null): string {
  const keys = Object.keys(values).sort((left, right) => Number(right === "host") - Number(left === "host"));
  const lines = keys.map((key) => {
    const proposed = visibleText(text(values[key as keyof ConnectionProposal]));
    return connection ? `${key}: ${proposed} (now ${visibleText(text(connection[key as keyof ConnectionView]))})` : `${key}: ${proposed}`;
  });
  return `An agent proposed these settings. Check the host before you type a password.\n${lines.join("\n")}`;
}


// True when an agent's proposal changes where an existing connection sends its saved secrets, which the server then
// does not keep.
export function movesSecrets(values: ConnectionProposal, connection: ConnectionView | null): boolean {
  if (!connection) return false;
  return DESTINATION_FIELDS.some((key) => key in values && JSON.stringify(values[key] ?? null) !== JSON.stringify(connection[key] ?? null));
}
