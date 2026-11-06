import { defineAttachmentSource, defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ENGINE_IDS, FILTER_OPS } from "./engines";

// Long and specific, so a real JSON value in a column is never mistaken for bytes.
export const BYTES_TAG = "$datawise.bytes";

export const engineId = z.enum(ENGINE_IDS);
export const safetyMode = z.enum(["read-only", "confirm", "open"]);
export type SafetyMode = z.infer<typeof safetyMode>;
export const tlsMode = z.enum(["off", "require", "verify"]);
export type TlsMode = z.infer<typeof tlsMode>;
export const environmentLabel = z.enum(["none", "development", "staging", "production"]);
export type EnvironmentLabel = z.infer<typeof environmentLabel>;
export const connectionColor = z.enum(["red", "amber", "green", "gray", "contrast"]);
export type ConnectionColor = z.infer<typeof connectionColor>;
export const agentAccess = z.enum(["none", "schema"]);
export type AgentAccess = z.infer<typeof agentAccess>;

// A secret in a save request: missing keeps the stored value, null clears it, a string replaces it.
const secretChange = z.string().nullable().optional();

export const sshInput = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().min(1),
});

export const connectionInput = z.object({
  // Missing id means a new connection.
  id: z.string().optional(),
  name: z.string().trim().min(1).max(120),
  engine: engineId,
  host: z.string().trim().default(""),
  port: z.number().int().min(1).max(65535).nullable().default(null),
  user: z.string().default(""),
  database: z.string().default(""),
  file: z.string().default(""),
  serviceName: z.string().default(""),
  localDataCenter: z.string().default(""),
  region: z.string().default(""),
  endpoint: z.string().default(""),
  accessKeyId: z.string().default(""),
  authSource: z.string().default(""),
  tls: tlsMode.default("off"),
  caCertificate: z.string().default(""),
  safety: safetyMode.default("confirm"),
  environment: environmentLabel.default("none"),
  color: connectionColor.nullable().default(null),
  group: z.string().trim().max(60).default(""),
  agentAccess: agentAccess.default("none"),
  ssh: sshInput.nullable().default(null),
  // False keeps the password in memory only, so it is asked for again after Paseo restarts.
  rememberPassword: z.boolean().default(true),
  password: secretChange,
  apiKey: secretChange,
  sshPassword: secretChange,
  sshPrivateKey: secretChange,
  sshPassphrase: secretChange,
});
export type ConnectionInput = z.input<typeof connectionInput>;

// What a client may see of a stored connection. Secrets appear only as has* flags.
export const connectionView = z.object({
  id: z.string(),
  name: z.string(),
  engine: engineId,
  host: z.string(),
  port: z.number().nullable(),
  user: z.string(),
  database: z.string(),
  file: z.string(),
  serviceName: z.string(),
  localDataCenter: z.string(),
  region: z.string(),
  endpoint: z.string(),
  accessKeyId: z.string(),
  authSource: z.string(),
  tls: tlsMode,
  caCertificate: z.string(),
  safety: safetyMode,
  environment: environmentLabel,
  color: connectionColor.nullable(),
  group: z.string(),
  agentAccess,
  ssh: sshInput.nullable(),
  sshHostFingerprint: z.string().nullable(),
  rememberPassword: z.boolean(),
  // True when a session-only password has not been entered since Paseo started.
  needsPassword: z.boolean(),
  hasPassword: z.boolean(),
  hasApiKey: z.boolean(),
  hasSshPassword: z.boolean(),
  hasSshPrivateKey: z.boolean(),
  hasSshPassphrase: z.boolean(),
  notEncrypted: z.boolean(),
});
export type ConnectionView = z.infer<typeof connectionView>;

export const scope = z.object({
  connectionId: z.string(),
  database: z.string().optional(),
  schema: z.string().optional(),
});
export type Scope = z.infer<typeof scope>;

export const objectRef = scope.extend({ name: z.string().min(1) });
export type ObjectRef = z.infer<typeof objectRef>;

export const filter = z.object({
  column: z.string().min(1),
  op: z.enum(FILTER_OPS),
  value: z.string().default(""),
});
export type Filter = z.infer<typeof filter>;

export const sort = z.object({ column: z.string().min(1), descending: z.boolean().default(false) });
export type Sort = z.infer<typeof sort>;

export const readQuery = z.object({
  limit: z.number().int().min(1).max(1000).default(100),
  cursor: z.string().nullable().default(null),
  sort: sort.nullable().default(null),
  filters: z.array(filter).max(20).default([]),
});
export type ReadQuery = z.infer<typeof readQuery>;

export const columnInfo = z.object({
  name: z.string(),
  type: z.string().nullable().default(null),
  nullable: z.boolean().nullable().default(null),
  defaultValue: z.string().nullable().default(null),
  isKey: z.boolean().default(false),
  // Filled in by the database, so the insert form leaves it out unless the user types a value.
  generated: z.boolean().default(false),
});
export type ColumnInfo = z.infer<typeof columnInfo>;

export const objectInfo = z.object({ name: z.string(), kind: z.string() });
export type ObjectInfo = z.infer<typeof objectInfo>;

export const objectPage = z.object({ objects: z.array(objectInfo), nextCursor: z.string().nullable() });
export type ObjectPage = z.infer<typeof objectPage>;

export const objectDetails = z.object({
  name: z.string(),
  kind: z.string(),
  columns: z.array(columnInfo),
  keyColumns: z.array(z.string()),
  // Why rows cannot be edited, when keyColumns is empty.
  keyReason: z.string().nullable(),
  indexes: z.array(z.object({ name: z.string(), columns: z.array(z.string()), unique: z.boolean() })),
  // The target fields are null when the engine's catalog does not settle them. No jump is offered then.
  foreignKeys: z.array(
    z.object({
      name: z.string(),
      columns: z.array(z.string()),
      references: z.string(),
      targetDatabase: z.string().nullable(),
      targetSchema: z.string().nullable(),
      targetTable: z.string().nullable(),
      targetColumns: z.array(z.string()),
    }),
  ),
  definition: z.string().nullable(),
  // Short facts such as a key's type and time to live.
  facts: z.array(z.object({ label: z.string(), value: z.string() })),
});
export type ObjectDetails = z.infer<typeof objectDetails>;

// A cut cell is marked by [row, column]. Marked cells must never be written back from the grid.
export const rowPage = z.object({
  columns: z.array(columnInfo),
  keyColumns: z.array(z.string()),
  keyReason: z.string().nullable(),
  rows: z.array(z.array(z.unknown())),
  cutCells: z.array(z.tuple([z.number(), z.number()])),
  nextCursor: z.string().nullable(),
  truncated: z.boolean(),
});
export type RowPage = z.infer<typeof rowPage>;

export const rowKey = z.record(z.string(), z.unknown());
export type RowKey = z.infer<typeof rowKey>;

export const writeOp = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("insert"), values: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("update"), key: rowKey, changes: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("delete"), keys: z.array(rowKey).min(1).max(1000) }),
]);
export type WriteOp = z.infer<typeof writeOp>;

// A staged edit. original holds what the user saw, compared again before writing: the changed columns of an
// update, and every whole value of a row to delete, so a delete cannot remove a row that has since changed.
export const stagedEdit = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("update"), key: rowKey, original: z.record(z.string(), z.unknown()), changes: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("delete"), key: rowKey, original: z.record(z.string(), z.unknown()) }),
]);
export type StagedEdit = z.infer<typeof stagedEdit>;

export const savedFilter = z.object({ name: z.string().trim().min(1).max(60), filters: z.array(filter).max(20) });
export type SavedFilter = z.infer<typeof savedFilter>;

// How one table is shown. Positions are never stored: column names are, so a changed table stays readable.
export const savedView = z.object({
  hiddenColumns: z.array(z.string()).default([]),
  columnOrder: z.array(z.string()).default([]),
  sort: sort.nullable().default(null),
  // What is applied now, so a table opens as it was left.
  filtersInUse: z.array(filter).max(20).default([]),
  filters: z.array(savedFilter).default([]),
});
export type SavedView = z.infer<typeof savedView>;

export const savedPlace = z.object({
  connectionId: z.string(),
  database: z.string().optional(),
  schema: z.string().optional(),
  object: z.object({ name: z.string(), kind: z.string() }).nullable(),
  tab: z.enum(["data", "structure", "query"]),
});
export type SavedPlace = z.infer<typeof savedPlace>;

export const queryTabRecord = z.object({ id: z.string(), name: z.string().max(60), text: z.string().max(1024 * 1024) });
export type QueryTabRecord = z.infer<typeof queryTabRecord>;
export const queryTabs = z.object({ activeId: z.string(), tabs: z.array(queryTabRecord).max(30) });
export type QueryTabs = z.infer<typeof queryTabs>;

export const queryResult = z.object({
  statement: z.string(),
  columns: z.array(columnInfo),
  rows: z.array(z.array(z.unknown())),
  cutCells: z.array(z.tuple([z.number(), z.number()])),
  truncated: z.boolean(),
  affected: z.number().nullable(),
  durationMs: z.number(),
  message: z.string().nullable(),
});
export type QueryResult = z.infer<typeof queryResult>;

export const historyEntry = z.object({
  id: z.string(),
  text: z.string(),
  ranAt: z.string(),
  durationMs: z.number().nullable(),
  ok: z.boolean(),
});
export type HistoryEntry = z.infer<typeof historyEntry>;

export const savedQuery = z.object({ id: z.string(), name: z.string(), text: z.string() });
export type SavedQuery = z.infer<typeof savedQuery>;

export const importFormat = z.enum(["csv", "tsv", "json", "ndjson"]);
export type ImportFormat = z.infer<typeof importFormat>;
export const exportFormat = z.enum(["csv", "tsv", "json", "ndjson", "sql"]);
export type ExportFormat = z.infer<typeof exportFormat>;

// Exactly one of path (absolute, on the daemon machine) and text (pasted).
export const importSource = z.union([z.object({ path: z.string().min(1) }), z.object({ text: z.string().min(1).max(16 * 1024 * 1024) })]);
export type ImportSource = z.infer<typeof importSource>;

export const importOptions = z.object({
  format: importFormat,
  // Target column -> source column. A target left out is not written.
  mapping: z.record(z.string(), z.string()),
  emptyIsNull: z.boolean().default(true),
  batchSize: z.number().int().min(1).max(5000).default(500),
});
export type ImportOptions = z.infer<typeof importOptions>;

export const exportSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("object"), ref: objectRef, sort: sort.nullable().default(null), filters: z.array(filter).max(20).default([]) }),
  z.object({ kind: z.literal("query"), scope, text: z.string().min(1) }),
]);
export type ExportSource = z.infer<typeof exportSource>;

// Every statement, write, count, import and export runs as a job the client polls, because Paseo gives
// up on an RPC after 30 seconds while the work would carry on. A failed job may still have results: the
// statements that ran before the one that failed.
export const jobView = z.object({
  id: z.string(),
  kind: z.enum(["query", "write", "count", "import", "export", "text"]),
  status: z.enum(["running", "done", "failed", "cancelled"]),
  rows: z.number(),
  message: z.string().nullable(),
  path: z.string().nullable(),
  startedAt: z.string(),
  results: z.array(queryResult).nullable(),
  affected: z.number().nullable(),
  count: z.number().nullable(),
  text: z.string().nullable(),
  truncated: z.boolean(),
  error: z.string().nullable(),
});
export type JobView = z.infer<typeof jobView>;

// An action that changes data either asks first or starts. Nothing has run when the answer is "confirm".
export const startResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("confirm"), preview: z.string(), reason: z.string() }),
  z.object({ status: z.literal("started"), job: jobView }),
]);
export type StartResult = z.infer<typeof startResult>;

const empty = z.object({});
const byId = z.object({ id: z.string() });
const ok = z.object({ ok: z.literal(true) });

export const rpc = {
  listConnections: defineRpc({ name: "connections.list", input: empty, output: z.object({ connections: z.array(connectionView) }) }),
  saveConnection: defineRpc({ name: "connections.save", input: connectionInput, output: connectionView }),
  deleteConnection: defineRpc({ name: "connections.delete", input: byId, output: ok }),
  // A failed connection is a normal answer here, not an RPC failure, so the form can show it.
  testConnection: defineRpc({
    name: "connections.test",
    input: connectionInput,
    output: z.object({
      ok: z.boolean(),
      serverVersion: z.string().nullable(),
      latencyMs: z.number().nullable(),
      error: z.string().nullable(),
      sshHostFingerprint: z.string().nullable(),
    }),
  }),
  disconnect: defineRpc({ name: "connections.disconnect", input: byId, output: ok }),
  unlockConnection: defineRpc({ name: "connections.unlock", input: z.object({ id: z.string(), password: z.string().min(1) }), output: connectionView }),
  clearSshFingerprint: defineRpc({ name: "connections.clear-ssh-fingerprint", input: byId, output: connectionView }),

  listDatabases: defineRpc({ name: "schema.databases", input: z.object({ connectionId: z.string() }), output: z.object({ databases: z.array(z.string()) }) }),
  listSchemas: defineRpc({ name: "schema.schemas", input: scope, output: z.object({ schemas: z.array(z.string()) }) }),
  listObjects: defineRpc({
    name: "schema.objects",
    input: scope.extend({ pattern: z.string().default(""), cursor: z.string().nullable().default(null) }),
    output: objectPage,
  }),
  describeObject: defineRpc({ name: "schema.describe", input: objectRef, output: objectDetails }),

  readRows: defineRpc({ name: "data.read", input: z.object({ ref: objectRef, query: readQuery }), output: rowPage }),
  countRows: defineRpc({ name: "data.count", input: z.object({ ref: objectRef, filters: z.array(filter).max(20).default([]) }), output: jobView }),
  readRow: defineRpc({ name: "data.read-row", input: z.object({ ref: objectRef, key: rowKey }), output: rowPage }),
  writeRows: defineRpc({ name: "data.write", input: z.object({ ref: objectRef, op: writeOp, confirmed: z.boolean().default(false) }), output: startResult }),
  // dryRun plans everything and returns the preview without writing. A key problem shows up here.
  writeBatch: defineRpc({
    name: "data.write-batch",
    input: z.object({ ref: objectRef, edits: z.array(stagedEdit).min(1).max(1000), dryRun: z.boolean().default(false), confirmed: z.boolean().default(false) }),
    output: startResult,
  }),
  // confirmName must equal the object's name; the server checks it.
  destroyObject: defineRpc({
    name: "data.destroy",
    input: z.object({ ref: objectRef, action: z.enum(["drop", "truncate"]), confirmName: z.string() }),
    output: startResult,
  }),

  runQuery: defineRpc({
    name: "query.run",
    input: z.object({
      scope,
      text: z.string().min(1).max(4 * 1024 * 1024),
      limit: z.number().int().min(1).max(100000).default(1000),
      timeoutMs: z.number().int().min(1000).max(3600000).default(60000),
      // Shows the plan of one statement instead of running it.
      explain: z.boolean().default(false),
      confirmed: z.boolean().default(false),
    }),
    output: startResult,
  }),
  listHistory: defineRpc({ name: "history.list", input: z.object({ connectionId: z.string() }), output: z.object({ entries: z.array(historyEntry) }) }),
  clearHistory: defineRpc({ name: "history.clear", input: z.object({ connectionId: z.string() }), output: ok }),
  listSaved: defineRpc({ name: "saved.list", input: z.object({ connectionId: z.string() }), output: z.object({ queries: z.array(savedQuery) }) }),
  saveQuery: defineRpc({ name: "saved.save", input: z.object({ connectionId: z.string(), id: z.string().optional(), name: z.string().trim().min(1).max(120), text: z.string().min(1) }), output: savedQuery }),
  deleteSaved: defineRpc({ name: "saved.delete", input: z.object({ connectionId: z.string(), id: z.string() }), output: ok }),

  importPreview: defineRpc({
    name: "import.preview",
    input: z.object({ source: importSource, format: importFormat }),
    output: z.object({ columns: z.array(z.string()), rows: z.array(z.record(z.string(), z.unknown())) }),
  }),
  startImport: defineRpc({
    name: "import.start",
    input: z.object({ ref: objectRef, source: importSource, options: importOptions, confirmed: z.boolean().default(false) }),
    output: startResult,
  }),
  startExport: defineRpc({
    name: "export.start",
    input: z.object({ source: exportSource, format: exportFormat, path: z.string().min(1) }),
    output: z.object({ job: jobView }),
  }),
  defaultExportPath: defineRpc({ name: "export.default-path", input: z.object({ name: z.string(), format: exportFormat }), output: z.object({ path: z.string() }) }),
  // Returns up to 5 MB of text for the clipboard. truncated says whether rows were left out.
  exportText: defineRpc({
    name: "export.text",
    input: z.object({ source: exportSource, format: exportFormat }),
    output: jobView,
  }),
  getView: defineRpc({ name: "views.get", input: objectRef, output: savedView }),
  saveView: defineRpc({ name: "views.save", input: z.object({ ref: objectRef, view: savedView }), output: ok }),
  getPlace: defineRpc({ name: "workspace.place.get", input: z.object({ surface: z.string() }), output: z.object({ place: savedPlace.nullable() }) }),
  savePlace: defineRpc({ name: "workspace.place.save", input: z.object({ surface: z.string(), place: savedPlace.nullable() }), output: ok }),
  getQueryTabs: defineRpc({ name: "workspace.tabs.get", input: z.object({ connectionId: z.string() }), output: z.object({ tabs: queryTabs.nullable() }) }),
  saveQueryTabs: defineRpc({ name: "workspace.tabs.save", input: z.object({ connectionId: z.string(), tabs: queryTabs }), output: ok }),
  // Reads only the file's first bytes, so it cannot change the file or create anything beside it.
  inspectSqlite: defineRpc({ name: "sqlite.inspect", input: z.object({ path: z.string().min(1) }), output: z.object({ isSqlite: z.boolean(), wal: z.boolean() }) }),
  jobStatus: defineRpc({ name: "jobs.status", input: byId, output: jobView }),
  cancelJob: defineRpc({ name: "jobs.cancel", input: byId, output: ok }),
};

// A person picks an item, and its text is added to their prompt. Search must return the text right away,
// so it holds structure only: reading rows here would read every match on every keystroke.
export const searchStructure = defineRpc({
  name: "attachments.structure",
  input: z.object({ query: z.string() }),
  output: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        identifier: z.string(),
        title: z.string(),
        subtitle: z.string().optional(),
        url: z.string().url(),
        text: z.string(),
        resourceType: z.string(),
      }),
    ),
  }),
});

export const structureAttachment = defineAttachmentSource({
  id: "table-structure",
  title: "Table structure",
  icon: "Table2",
  pickerTitle: "Attach a table's structure",
  searchPlaceholder: "Table name",
  search: searchStructure,
});
