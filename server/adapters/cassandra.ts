import type { Client, ClientOptions } from "cassandra-driver";
import { loadDriver } from "../drivers";
import { tlsClientOptions } from "../tls";
import type { ColumnInfo, Filter, ObjectDetails, ObjectPage, ObjectRef, QueryResult, ReadQuery, RowKey, RowPage, Scope, WriteOp } from "../../shared/contracts";
import { finishRows, fromCell, positionsOf } from "../cells";
import { errorMessage } from "../errors";
import { classifyCql, splitStatements } from "../sql-script";
import { ansiQuote, PartialRunError, renderLiteral, STREAM_BATCH } from "./sql-base";
import type { Adapter, AdapterContext, ParsedStatement, RunContext, StreamBatch, StreamSource, WritePlan } from "./types";

const COMPARE: Partial<Record<Filter["op"], string>> = { eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" };

class CassandraAdapter implements Adapter {
  private clientPromise: Promise<Client> | null = null;
  private readonly context: AdapterContext;

  constructor(context: AdapterContext) {
    this.context = context;
  }

  private client(): Promise<Client> {
    this.clientPromise ??= (async () => {
      const { connection, endpoint } = this.context;
      if (!endpoint) throw new Error("Cassandra needs a host.");
      const driver = await loadDriver<typeof import("cassandra-driver")>("cassandra-driver");
      // Behind a tunnel or NAT the addresses a node reports cannot be dialled, so keep to this one.
      const { AddressTranslator } = driver.policies.addressResolution as unknown as { AddressTranslator: new () => object };
      class StayOnThisHost extends AddressTranslator {
        translate(_address: string, _port: number, callback: (translated: string) => void) {
          callback(`${endpoint?.host}:${endpoint?.port}`);
        }
      }
      const options: ClientOptions = {
        contactPoints: [endpoint.host],
        protocolOptions: { port: endpoint.port },
        localDataCenter: connection.localDataCenter || "datacenter1",
        socketOptions: { connectTimeout: 15000 },
        policies: { addressResolution: new StayOnThisHost() as never },
        authProvider: connection.user ? new driver.auth.PlainTextAuthProvider(connection.user, connection.password ?? "") : undefined,
        sslOptions: connection.tls === "off" ? undefined : (tlsClientOptions(connection, endpoint) as never),
      };
      const client = new driver.Client(options);
      await client.connect();
      return client;
    })();
    this.clientPromise.catch(() => {
      this.clientPromise = null;
    });
    return this.clientPromise;
  }

  private table(ref: ObjectRef): string {
    if (!ref.schema) throw new Error("Pick a keyspace first.");
    return `${ansiQuote(ref.schema)}.${ansiQuote(ref.name)}`;
  }

  async ping() {
    const client = await this.client();
    const rows = await client.execute("SELECT release_version FROM system.local");
    return { serverVersion: `Cassandra ${String(rows.first()?.get("release_version") ?? "unknown")}` };
  }

  async listDatabases() {
    return [];
  }

  async listSchemas() {
    const client = await this.client();
    const rows = await client.execute("SELECT keyspace_name FROM system_schema.keyspaces");
    return rows.rows
      .map((row) => String(row.get("keyspace_name")))
      .sort((a, b) => Number(a.startsWith("system")) - Number(b.startsWith("system")) || a.localeCompare(b));
  }

  async listObjects(scope: Scope, options: { pattern: string; cursor: string | null }): Promise<ObjectPage> {
    if (!scope.schema) return { objects: [], nextCursor: null };
    const client = await this.client();
    const tables = await client.execute("SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?", [scope.schema], { prepare: true });
    const views = await client.execute("SELECT view_name FROM system_schema.views WHERE keyspace_name = ?", [scope.schema], { prepare: true });
    const needle = options.pattern.toLowerCase();
    const objects = [...tables.rows.map((row) => ({ name: String(row.get("table_name")), kind: "table" })), ...views.rows.map((row) => ({ name: String(row.get("view_name")), kind: "view" }))];
    return { objects: objects.filter((item) => !needle || item.name.toLowerCase().includes(needle)).sort((a, b) => a.name.localeCompare(b.name)), nextCursor: null };
  }

  private async columnRows(ref: ObjectRef) {
    const client = await this.client();
    const rows = await client.execute("SELECT column_name, type, kind, position FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?", [ref.schema, ref.name], { prepare: true });
    if (rows.rowLength === 0) throw new Error(`${ref.name} was not found in ${ref.schema ?? "this keyspace"}.`);
    return rows.rows.map((row) => ({ name: String(row.get("column_name")), type: String(row.get("type")), kind: String(row.get("kind")), position: Number(row.get("position")) }));
  }

  private keyOf(columns: { name: string; kind: string; position: number }[]): string[] {
    const partition = columns.filter((column) => column.kind === "partition_key").sort((a, b) => a.position - b.position);
    const clustering = columns.filter((column) => column.kind === "clustering").sort((a, b) => a.position - b.position);
    return [...partition, ...clustering].map((column) => column.name);
  }

  private async isView(ref: ObjectRef): Promise<boolean> {
    const client = await this.client();
    return (await client.execute("SELECT view_name FROM system_schema.views WHERE keyspace_name = ? AND view_name = ?", [ref.schema, ref.name], { prepare: true })).rowLength > 0;
  }

  async describe(ref: ObjectRef): Promise<ObjectDetails> {
    const columns = await this.columnRows(ref);
    const view = await this.isView(ref);
    const key = view ? [] : this.keyOf(columns);
    const client = await this.client();
    const indexes = await client.execute("SELECT index_name, options FROM system_schema.indexes WHERE keyspace_name = ? AND table_name = ?", [ref.schema, ref.name], { prepare: true });
    return {
      name: ref.name,
      kind: view ? "view" : "table",
      columns: columns.map((column) => ({ name: column.name, type: column.type, nullable: column.kind === "regular" || column.kind === "static", defaultValue: null, isKey: key.includes(column.name), generated: false })),
      keyColumns: key,
      keyReason: view ? "A materialized view cannot be edited." : null,
      indexes: [{ name: "primary key", columns: this.keyOf(columns), unique: true }, ...indexes.rows.map((row) => ({ name: String(row.get("index_name")), columns: [String((row.get("options") as Record<string, string>)?.target ?? "")], unique: false }))],
      foreignKeys: [],
      definition: null,
      facts: [{ label: "Partition key", value: columns.filter((column) => column.kind === "partition_key").map((column) => column.name).join(", ") }],
    };
  }

  private where(filters: Filter[], columns: { name: string; type: string }[]): { sql: string; params: unknown[]; filtering: boolean } {
    const parts: string[] = [];
    const params: unknown[] = [];
    for (const item of filters) {
      const column = columns.find((candidate) => candidate.name === item.column);
      if (!column) throw new Error(`Unknown column: ${item.column}`);
      const op = COMPARE[item.op];
      if (!op) throw new Error("Cassandra filters compare whole values only.");
      parts.push(`${ansiQuote(item.column)} ${op} ?`);
      params.push(this.coerce(item.value, column.type));
    }
    return { sql: parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "", params, filtering: parts.length > 0 };
  }

  // CQL prepared statements are strictly typed, so text from a form has to become the column's type.
  private coerce(value: unknown, type: string): unknown {
    const decoded = fromCell(value);
    if (decoded === null || typeof decoded !== "string") return decoded;
    if (["int", "smallint", "tinyint", "float", "double"].includes(type)) {
      const number = Number(decoded);
      // Number("") is 0, so a cleared field would otherwise store a zero.
      if (decoded.trim() === "" || Number.isNaN(number)) throw new Error(`"${decoded}" is not a ${type}. To clear it, use NULL.`);
      return number;
    }
    if (type === "boolean") {
      if (decoded !== "true" && decoded !== "false") throw new Error(`${decoded} is not a boolean.`);
      return decoded === "true";
    }
    if (type.startsWith("list<") || type.startsWith("set<") || type.startsWith("map<") || type.startsWith("frozen<")) return JSON.parse(decoded);
    return decoded;
  }

  // An agent's read. Datawise builds this query itself, so no agent-written text reaches the database.
  readIsolated(ref: ObjectRef, query: ReadQuery, cellLimit: number): Promise<RowPage> {
    return this.read(ref, query, cellLimit, true);
  }

  async read(ref: ObjectRef, query: ReadQuery, cellLimit: number, bytesAsSize = false): Promise<RowPage> {
    if (query.sort) throw new Error("Cassandra returns rows in clustering order only, so a table cannot be sorted here.");
    const client = await this.client();
    const columns = await this.columnRows(ref);
    const view = await this.isView(ref);
    const where = this.where(query.filters, columns);
    const result = await client.execute(`SELECT * FROM ${this.table(ref)}${where.sql}${where.filtering ? " ALLOW FILTERING" : ""}`, where.params, { prepare: true, fetchSize: query.limit, pageState: query.cursor ?? undefined });
    const names = result.columns?.map((column) => column.name) ?? columns.map((column) => column.name);
    const key = view ? [] : this.keyOf(columns);
    const finished = finishRows(result.rows.map((row) => names.map((name) => this.toPlain(row.get(name)))), null, cellLimit, bytesAsSize, positionsOf(names, key));
    return {
      columns: names.map((name) => ({ name, type: columns.find((column) => column.name === name)?.type ?? null, nullable: !key.includes(name), defaultValue: null, isKey: key.includes(name), generated: false })),
      keyColumns: key,
      keyReason: view ? "A materialized view cannot be edited." : null,
      rows: finished.rows,
      cutCells: finished.cutCells,
      truncated: finished.truncated,
      nextCursor: result.pageState ?? null,
    };
  }

  // Driver wrappers such as Uuid, Long and LocalDate print as their text form.
  private toPlain(value: unknown): unknown {
    if (value && typeof value === "object" && !(value instanceof Date) && !(value instanceof Uint8Array) && !Array.isArray(value) && value.constructor !== Object && !(value instanceof Map) && !(value instanceof Set)) return String(value);
    if (value instanceof Map) return Object.fromEntries([...value.entries()].map(([k, v]) => [String(k), this.toPlain(v)]));
    if (value instanceof Set) return [...value].map((item) => this.toPlain(item));
    if (Array.isArray(value)) return value.map((item) => this.toPlain(item));
    return value;
  }

  async count(ref: ObjectRef, filters: Filter[], timeoutMs: number): Promise<number> {
    const client = await this.client();
    const where = this.where(filters, await this.columnRows(ref));
    const result = await client.execute(`SELECT COUNT(*) FROM ${this.table(ref)}${where.sql}${where.filtering ? " ALLOW FILTERING" : ""}`, where.params, { prepare: true, readTimeout: timeoutMs });
    return Number(result.first()?.get(0) ?? 0);
  }

  private keyClause(key: RowKey, keyColumns: string[], columns: { name: string; type: string }[]) {
    const names = Object.keys(key);
    if (names.length !== keyColumns.length || !keyColumns.every((name) => names.includes(name))) throw new Error(`A row is identified by exactly: ${keyColumns.join(", ")}.`);
    const params = keyColumns.map((name) => {
      if (key[name] === null || key[name] === undefined) throw new Error(`The key column ${name} has no value.`);
      return this.coerce(key[name], columns.find((column) => column.name === name)?.type ?? "text");
    });
    return { sql: keyColumns.map((name) => `${ansiQuote(name)} = ?`).join(" AND "), params, shown: keyColumns.map((name) => `${ansiQuote(name)} = ${renderLiteral(key[name])}`).join(" AND ") };
  }

  async readRow(ref: ObjectRef, key: RowKey): Promise<RowPage> {
    const client = await this.client();
    const columns = await this.columnRows(ref);
    const keyColumns = this.keyOf(columns);
    const clause = this.keyClause(key, keyColumns, columns);
    const result = await client.execute(`SELECT * FROM ${this.table(ref)} WHERE ${clause.sql}`, clause.params, { prepare: true });
    const names = result.columns?.map((column) => column.name) ?? [];
    const finished = finishRows(result.rows.map((row) => names.map((name) => this.toPlain(row.get(name)))), null, Number.MAX_SAFE_INTEGER);
    return { columns: names.map((name) => ({ name, type: columns.find((column) => column.name === name)?.type ?? null, nullable: !keyColumns.includes(name), defaultValue: null, isKey: keyColumns.includes(name), generated: false })), keyColumns, keyReason: null, rows: finished.rows, cutCells: [], truncated: false, nextCursor: null };
  }

  async planWrite(ref: ObjectRef, op: WriteOp): Promise<WritePlan> {
    const client = await this.client();
    const columns = await this.columnRows(ref);
    if (await this.isView(ref)) throw new Error("A materialized view cannot be edited.");
    const keyColumns = this.keyOf(columns);
    const typeOf = (name: string) => {
      const column = columns.find((item) => item.name === name);
      if (!column) throw new Error(`Unknown column: ${name}`);
      return column.type;
    };
    const table = this.table(ref);
    if (op.kind === "insert") {
      const names = Object.keys(op.values);
      const missing = keyColumns.filter((name) => op.values[name] === undefined || op.values[name] === null);
      if (missing.length > 0) throw new Error(`Give a value for the key: ${missing.join(", ")}.`);
      const params = names.map((name) => this.coerce(op.values[name], typeOf(name)));
      // IF NOT EXISTS keeps an insert from silently replacing a row with the same key, which a plain
      // CQL INSERT would do.
      const sql = `INSERT INTO ${table} (${names.map(ansiQuote).join(", ")}) VALUES (${names.map(() => "?").join(", ")}) IF NOT EXISTS`;
      return {
        preview: `INSERT INTO ${table} (${names.map(ansiQuote).join(", ")}) VALUES (${params.map(renderLiteral).join(", ")}) IF NOT EXISTS`,
        run: async () => {
          const result = await client.execute(sql, params, { prepare: true });
          if (result.first()?.get("[applied]") === false) throw new Error("A row with this key already exists. Nothing was changed.");
          return 1;
        },
      };
    }
    if (op.kind === "update") {
      const names = Object.keys(op.changes);
      if (names.length === 0) throw new Error("Nothing changed.");
      for (const name of names) if (keyColumns.includes(name)) throw new Error(`The key column ${name} cannot be changed. Insert a new row and delete this one instead.`);
      const clause = this.keyClause(op.key, keyColumns, columns);
      const values = names.map((name) => this.coerce(op.changes[name], typeOf(name)));
      // IF EXISTS: a plain CQL UPDATE creates the row if it is gone.
      const sql = `UPDATE ${table} SET ${names.map((name) => `${ansiQuote(name)} = ?`).join(", ")} WHERE ${clause.sql} IF EXISTS`;
      return {
        preview: `UPDATE ${table} SET ${names.map((name, index) => `${ansiQuote(name)} = ${renderLiteral(values[index])}`).join(", ")} WHERE ${clause.shown} IF EXISTS`,
        run: async () => {
          const result = await client.execute(sql, [...values, ...clause.params], { prepare: true });
          if (result.first()?.get("[applied]") === false) throw new Error("No row matched its key. Someone may have deleted it; refresh and try again.");
          return 1;
        },
      };
    }
    const clauses = op.keys.map((key) => this.keyClause(key, keyColumns, columns));
    const shown = clauses.slice(0, 20).map((clause) => `DELETE FROM ${table} WHERE ${clause.shown}`);
    if (clauses.length > 20) shown.push(`...and ${clauses.length - 20} more`);
    return {
      preview: shown.join("\n"),
      run: async () => {
        for (const clause of clauses) await client.execute(`DELETE FROM ${table} WHERE ${clause.sql}`, clause.params, { prepare: true });
        return clauses.length;
      },
    };
  }

  async planDestroy(ref: ObjectRef, action: "drop" | "truncate"): Promise<WritePlan> {
    const client = await this.client();
    const view = await this.isView(ref);
    const sql = action === "truncate" ? `TRUNCATE ${this.table(ref)}` : view ? `DROP MATERIALIZED VIEW ${this.table(ref)}` : `DROP TABLE ${this.table(ref)}`;
    return {
      preview: sql,
      run: async () => {
        await client.execute(sql);
        return 0;
      },
    };
  }

  async parse(text: string): Promise<ParsedStatement[]> {
    return splitStatements(text, "cassandra").map((statement) => ({ text: statement.text, class: classifyCql(statement) }));
  }

  async run(statements: ParsedStatement[], context: RunContext): Promise<QueryResult[]> {
    const client = await this.client();
    const results: QueryResult[] = [];
    for (const statement of statements) {
      if (context.signal.aborted) throw new PartialRunError("Cancelled.", results);
      const started = Date.now();
      try {
        const rows: unknown[][] = [];
        let columns: ColumnInfo[] = [];
        let pageState: string | undefined;
        let truncated = false;
        const keyspace = context.scope.schema;
        do {
          const result = await client.execute(statement.text, [], { fetchSize: Math.min(STREAM_BATCH, context.limit + 1), pageState, keyspace, readTimeout: context.timeoutMs } as never);
          const names = result.columns?.map((column) => column.name) ?? [];
          columns = names.map((name) => ({ name, type: null, nullable: null, defaultValue: null, isKey: false, generated: false }));
          // A statement with no result set has no rows array at all.
          for (const row of result.rows ?? []) {
            if (rows.length >= context.limit) {
              truncated = true;
              break;
            }
            rows.push(names.map((name) => this.toPlain(row.get(name))));
          }
          pageState = truncated ? undefined : (result.pageState ?? undefined);
        } while (pageState);
        const finished = finishRows(rows, null, context.cellLimit, context.bytesAsSize);
        results.push({ statement: statement.text, columns, rows: finished.rows, cutCells: finished.cutCells, truncated: truncated || finished.truncated, affected: null, durationMs: Date.now() - started, message: null });
      } catch (error) {
        throw new PartialRunError(errorMessage(error), results);
      }
    }
    return results;
  }

  async stream(source: StreamSource, signal: AbortSignal, onBatch: (batch: StreamBatch) => Promise<boolean>): Promise<void> {
    const client = await this.client();
    let sql: string;
    let params: unknown[] = [];
    let keyspace: string | undefined;
    if (source.kind === "object") {
      const where = this.where(source.filters, await this.columnRows(source.ref));
      sql = `SELECT * FROM ${this.table(source.ref)}${where.sql}${where.filtering ? " ALLOW FILTERING" : ""}`;
      params = where.params;
    } else {
      const statements = await this.parse(source.text);
      if (statements.length !== 1 || statements[0]?.class !== "read") throw new Error("Export runs one read statement.");
      sql = statements[0].text;
      keyspace = source.scope.schema;
    }
    let pageState: string | undefined;
    do {
      if (signal.aborted) throw new Error("Cancelled.");
      const result = await client.execute(sql, params, { prepare: params.length > 0, fetchSize: STREAM_BATCH, pageState, keyspace } as never);
      const names = result.columns?.map((column) => column.name) ?? [];
      if (result.rows.length > 0 && !(await onBatch({ columns: names.map((name) => ({ name, type: null, nullable: null, defaultValue: null, isKey: false, generated: false })), rows: result.rows.map((row) => names.map((name) => this.toPlain(row.get(name)))) }))) return;
      pageState = result.pageState ?? undefined;
    } while (pageState);
  }

  async importInto(ref: ObjectRef, names: string[], produce: (insert: (rows: unknown[][]) => Promise<void>) => Promise<void>): Promise<void> {
    const client = await this.client();
    const columns = await this.columnRows(ref);
    const types = names.map((name) => {
      const column = columns.find((item) => item.name === name);
      if (!column) throw new Error(`Unknown column: ${name}`);
      return column.type;
    });
    const sql = `INSERT INTO ${this.table(ref)} (${names.map(ansiQuote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
    await produce(async (rows) => {
      for (const row of rows) await client.execute(sql, row.map((value, index) => this.coerce(value, types[index] ?? "text")), { prepare: true });
    });
  }

  async close() {
    const client = this.clientPromise;
    this.clientPromise = null;
    if (client) await (await client).shutdown();
  }
}

export async function createCassandra(context: AdapterContext): Promise<Adapter> {
  return new CassandraAdapter(context);
}
