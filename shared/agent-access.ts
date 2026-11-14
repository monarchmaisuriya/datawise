import type { AgentAccess, AgentRowAccess, EnvironmentLabel, SafetyMode } from "./contracts";
import type { EngineId } from "./engines";

interface AccessFields {
  engine: EngineId;
  environment: EnvironmentLabel;
  safety: SafetyMode;
  agentAccess: AgentAccess;
  agentRowAccess: AgentRowAccess;
}

// Row access needs a label saying this is not production. The default label says nothing either way.
export function rowAccessPossible(environment: EnvironmentLabel): boolean {
  return environment === "development" || environment === "staging";
}

export function agentRowAccessRefusal(input: AccessFields): string | null {
  if (input.agentRowAccess === "none") return null;
  if (input.agentAccess !== "schema") return "Share table and column names with agents before sharing rows.";
  if (!rowAccessPossible(input.environment)) return "Agents can only reach rows on a connection labelled development or staging.";
  if (input.agentRowAccess === "propose" && input.safety === "read-only") return "A read-only connection cannot take proposed changes.";
  return null;
}

// What a connection allows right now. Checked on every tool call, so a hand-edited file gets no more.
export function agentRowLevel(connection: AccessFields): AgentRowAccess {
  if (connection.agentRowAccess === "none") return "none";
  if (agentRowAccessRefusal({ ...connection, agentRowAccess: "read" })) return "none";
  return connection.agentRowAccess === "propose" && connection.safety !== "read-only" ? "propose" : "read";
}
