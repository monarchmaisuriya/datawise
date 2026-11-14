import { randomUUID } from "node:crypto";
import type { AgentRequestItem, AgentRequestSummary, ConnectionProposal, EnvironmentLabel, ObjectRef, StagedEdit } from "../shared/contracts";
import type { ParsedStatement } from "./adapters/types";

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
  statements: ParsedStatement[] | null;
  // On an engine without transactions, one failed statement can still have changed some data.
  mayBePartial: boolean;
  // How many proposed statements ran before one failed. The agent gets this count, never the database's error.
  ran: number | null;
  // An app action run after approval through the same handler the app calls, with its input already parsed.
  action: { name: string; input: unknown; expectedText?: string } | null;
  // A connection an agent proposed. It is approved by the person saving the connection form, never by Approve.
  connectionProposal: ConnectionProposal | null;
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
  statements: ParsedStatement[] | null;
  mayBePartial: boolean;
  action?: { name: string; input: unknown; expectedText?: string } | null;
  connectionProposal?: ConnectionProposal | null;
  headline?: string | null;
}

function summary(request: AgentRequest): AgentRequestSummary {
  const { ref: _ref, target: _target, items: _items, inserts: _inserts, edits: _edits, statements: _statements, mayBePartial: _mayBePartial, ran: _ran, action: _action, connectionProposal: _proposal, ...rest } = request;
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
    // A new connection has no id yet, so its proposals count only against the agent that made them.
    if (connectionId !== "" && pending.filter((request) => request.connectionId === connectionId).length >= MAX_PER_CONNECTION) return `This connection already has ${MAX_PER_CONNECTION} requests waiting. Wait for the person to answer them.`;
    if (pending.filter((request) => request.agentId === agentId).length >= MAX_PER_AGENT) return `You already have ${MAX_PER_AGENT} requests waiting. Wait for the person to answer them.`;
    return null;
  }

  add(fields: NewRequest): AgentRequest {
    const refusal = this.limitReached(fields.connectionId, fields.agentId);
    if (refusal) throw new Error(refusal);
    const now = Date.now();
    const action = fields.action ?? null;
    const connectionProposal = fields.connectionProposal ?? null;
    const kind = connectionProposal ? "connection" : action ? "action" : "change";
    const request: AgentRequest = { ...fields, action, connectionProposal, kind, headline: fields.headline ?? null, id: randomUUID(), rows: fields.items.length, unit: fields.statements ? "statements" : "rows", status: "pending", message: null, affected: null, ran: null, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + TTL_MS).toISOString() };
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

  // keep is the request whose own approval caused this, which finishes as done instead.
  expireConnection(connectionId: string, message: string, keep: string | null = null) {
    for (const request of this.requests.values()) if (request.connectionId === connectionId && request.status === "pending" && request.id !== keep) this.expire(request, message);
  }

  // Held while the person's save runs, so a second press cannot save the proposal twice.
  claimConnection(id: string): AgentRequest {
    const request = this.get(id);
    if (request.kind !== "connection") throw new Error("This request is not a connection the agent proposed.");
    if (request.status !== "pending") throw new Error(`This request is already ${request.status}, so the form was not saved for it.`);
    request.status = "running";
    return request;
  }

  releaseConnection(id: string): void {
    const request = this.requests.get(id);
    if (request?.status === "running") request.status = "pending";
  }

  // A connection request ends when the person's save of the form succeeds, in the same step as that save.
  completeConnection(id: string, connectionId: string, connectionName: string): AgentRequest {
    const request = this.get(id);
    if (request.status !== "running") throw new Error(`This request is already ${request.status}.`);
    request.status = "done";
    request.connectionId = connectionId;
    request.connectionName = connectionName;
    return request;
  }

  summaryOf(request: AgentRequest): AgentRequestSummary {
    return summary(request);
  }
}
