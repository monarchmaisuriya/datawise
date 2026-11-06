import type { SafetyMode } from "../shared/contracts";

export interface GateRequest {
  mode: SafetyMode;
  // True when the action can change data, or when that could not be ruled out.
  writes: boolean;
  confirmed: boolean;
  preview: string;
  reason?: string;
}

export type GateAnswer = { kind: "run" } | { kind: "confirm"; preview: string; reason: string };

// The one place that decides whether a write may go ahead. Every write path calls this, so a path
// that forgets it is the only way to bypass it, and adapters take no safety argument of their own.
export function gate(request: GateRequest): GateAnswer {
  if (!request.writes) return { kind: "run" };
  if (request.mode === "read-only") throw new Error(`This connection is read-only. Refused: ${request.preview.slice(0, 300)}`);
  if (request.mode === "confirm" && !request.confirmed) return { kind: "confirm", preview: request.preview, reason: request.reason ?? "This can change data." };
  return { kind: "run" };
}

export function checkDestroyName(objectName: string, confirmName: string): void {
  if (objectName !== confirmName) throw new Error(`Type the exact name "${objectName}" to confirm.`);
}
