import type { ColumnInfo, Filter, ObjectDetails, ObjectPage, ObjectRef, QueryResult, ReadQuery, RowKey, RowPage, Scope, Sort, StagedEdit, WriteOp } from "../../shared/contracts";
import type { StatementClass } from "../sql-script";
import type { StoredConnection } from "../store";

export interface ParsedStatement {
  text: string;
  class: StatementClass;
}

export interface WritePlan {
  // What the user reads before agreeing. Plain text, values included.
  preview: string;
  run(): Promise<number>;
}

export interface RunContext {
  scope: Scope;
  limit: number;
  timeoutMs: number;
  signal: AbortSignal;
  // The session must refuse writes, so a misclassified statement still cannot change data.
  readOnly: boolean;
  // Values longer than this are cut and listed; an agent gets less than a person.
  cellLimit: number;
  // Shows binary as its size, for a reader who must not get the bytes.
  bytesAsSize: boolean;
}

export interface StreamBatch {
  columns: ColumnInfo[];
  rows: unknown[][];
}

export type StreamSource = { kind: "object"; ref: ObjectRef; sort: Sort | null; filters: Filter[] } | { kind: "query"; scope: Scope; text: string };

export interface InsertResult {
  inserted: number;
}

export interface Adapter {
  ping(): Promise<{ serverVersion: string }>;
  listDatabases(): Promise<string[]>;
  listSchemas(scope: Scope): Promise<string[]>;
  listObjects(scope: Scope, options: { pattern: string; cursor: string | null }): Promise<ObjectPage>;
  describe(ref: ObjectRef): Promise<ObjectDetails>;
  // A page for the grid. Values longer than cellLimit are cut and listed; keys never are.
  read(ref: ObjectRef, query: ReadQuery, cellLimit: number): Promise<RowPage>;
  // Stops at the deadline: a count can be a full scan, which some engines bill.
  count(ref: ObjectRef, filters: Filter[], timeoutMs: number): Promise<number>;
  readRow(ref: ObjectRef, key: RowKey): Promise<RowPage>;
  planWrite(ref: ObjectRef, op: WriteOp): Promise<WritePlan>;
  planDestroy(ref: ObjectRef, action: "drop" | "truncate"): Promise<WritePlan>;
  // Several edits that land together or not at all. Only engines with transactionalEdits have this.
  planBatch?(ref: ObjectRef, edits: StagedEdit[]): Promise<WritePlan>;
  planInserts?(ref: ObjectRef, rows: Record<string, unknown>[]): Promise<WritePlan>;
  // A read that cannot change anything, for callers that are not a person at the keyboard.
  readIsolated(ref: ObjectRef, query: ReadQuery, cellLimit: number): Promise<RowPage>;
  readRowIsolated?(ref: ObjectRef, key: RowKey): Promise<RowPage>;
  // Splits text into statements and marks each read or write. Anything not proved a read is a write.
  parse(text: string): Promise<ParsedStatement[]>;
  run(statements: ParsedStatement[], context: RunContext): Promise<QueryResult[]>;
  // Calls onBatch until the source is exhausted, the signal aborts, or onBatch returns false.
  stream(source: StreamSource, signal: AbortSignal, onBatch: (batch: StreamBatch) => Promise<boolean>): Promise<void>;
  // Runs inserts inside one unit of work where the engine has one: if the callback throws, none land.
  importInto(ref: ObjectRef, columns: string[], produce: (insert: (rows: unknown[][]) => Promise<void>) => Promise<void>): Promise<void>;
  close(): Promise<void>;
}

// A live endpoint after any SSH tunnel: host and port to dial, with the original host for TLS checks.
export interface Endpoint {
  host: string;
  port: number;
  tlsServername: string;
}

export interface AdapterContext {
  connection: StoredConnection;
  endpoint: Endpoint | null;
  // Called when the transport is gone, so the pool drops this adapter.
  onLost(): void;
}

export type AdapterFactory = (context: AdapterContext) => Promise<Adapter>;

export function requireKey(ref: ObjectRef, keyColumns: string[], keyReason: string | null): void {
  if (keyColumns.length === 0) throw new Error(keyReason ?? `${ref.name} has no key, so its rows cannot be changed one at a time.`);
}
