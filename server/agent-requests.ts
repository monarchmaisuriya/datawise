import { randomUUID } from "node:crypto";
import type { AgentRequestItem, AgentRequestSummary, EnvironmentLabel, ObjectRef, StagedEdit } from "../shared/contracts";

const TTL_MS = 30 * 60 * 1000;
const FORGET_AFTER_MS = 60 * 60 * 1000;
export const MAX_PER_CONNECTION = 20;
export const MAX_PER_AGENT = 5;
export const MAX_ROWS = 100;
export const MAX_BYTES = 1024 * 1024;

export interface AgentRequest extends AgentRequestSummary {
  ref: ObjectRef;
  // What server this was proposed against. A save can repoint a connection while a proposal is under way.
  target: string;
  items: AgentRequestItem[];
  // Exactly one of these is what runs, once a person approves.
  inserts: Record<string, unknown>[] | null;
  edits: StagedEdit[] | null;
}

export interface NewRequest {
  agentId: string;
  agentTitle: string | null;
  connectionId: string;
  connectionName: string;
  environment: EnvironmentLabel;
  place: string;
  ref: ObjectRef;
  target: string;
  items: AgentRequestItem[];
  inserts: Record<string, unknown>[] | null;
  edits: StagedEdit[] | null;
}

function summary(request: AgentRequest): AgentRequestSummary {
  const { ref: _ref, target: _target, items: _items, inserts: _inserts, edits: _edits, ...rest } = request;
  return rest;
}

// In memory on purpose: a restart or reload drops every waiting request, so nothing can run late.
export class AgentRequests {
  private readonly requests = new Map<string, AgentRequest>();

  constructor(private readonly onExpired: (request: AgentRequest) => void = () => undefined) {}

  private sweep() {
    const now = Date.now();
    for (const request of this.requests.values()) {
      if (request.status === "pending" && Date.parse(request.expiresAt) <= now) this.expire(request, "Nobody answered within 30 minutes.");
      else if (request.status !== "pending" && request.status !== "running" && Date.parse(request.expiresAt) + FORGET_AFTER_MS <= now) this.requests.delete(request.id);
    }
  }

  private expire(request: AgentRequest, message: string) {
    request.status = "expired";
    request.message = message;
    this.onExpired(request);
  }

  // Returns why it cannot be added, or null. Checked again by add, so both agree.
  limitReached(connectionId: string, agentId: string): string | null {
    this.sweep();
    const pending = [...this.requests.values()].filter((request) => request.status === "pending");
    if (pending.filter((request) => request.connectionId === connectionId).length >= MAX_PER_CONNECTION) return `This connection already has ${MAX_PER_CONNECTION} requests waiting. Wait for the person to answer them.`;
    if (pending.filter((request) => request.agentId === agentId).length >= MAX_PER_AGENT) return `You already have ${MAX_PER_AGENT} requests waiting. Wait for the person to answer them.`;
    return null;
  }

  add(fields: NewRequest): AgentRequest {
    const refusal = this.limitReached(fields.connectionId, fields.agentId);
    if (refusal) throw new Error(refusal);
    const now = Date.now();
    const request: AgentRequest = { ...fields, id: randomUUID(), rows: fields.items.length, status: "pending", message: null, affected: null, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + TTL_MS).toISOString() };
    this.requests.set(request.id, request);
    return request;
  }

  list(): AgentRequestSummary[] {
    this.sweep();
    return [...this.requests.values()].map(summary).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  get(id: string): AgentRequest {
    this.sweep();
    const request = this.requests.get(id);
    if (!request) throw new Error("This request is gone. Datawise may have restarted, or it finished a while ago.");
    return request;
  }

  // Only the agent that asked can see a request, and anything else gets the answer for an unknown id.
  forAgent(id: string, agentId: string): AgentRequest | null {
    this.sweep();
    const request = this.requests.get(id);
    return request && request.agentId === agentId ? request : null;
  }

  // Flips the state before anything else happens, so a second press or a race cannot run it twice.
  take(id: string): AgentRequest {
    const request = this.get(id);
    if (request.status !== "pending") throw new Error(`This request is already ${request.status}.`);
    request.status = "running";
    return request;
  }

  reject(id: string): AgentRequest {
    const request = this.get(id);
    if (request.status !== "pending") throw new Error(`This request is already ${request.status}.`);
    request.status = "rejected";
    return request;
  }

  expireConnection(connectionId: string, message: string) {
    for (const request of this.requests.values()) if (request.connectionId === connectionId && request.status === "pending") this.expire(request, message);
  }

  summaryOf(request: AgentRequest): AgentRequestSummary {
    return summary(request);
  }
}
