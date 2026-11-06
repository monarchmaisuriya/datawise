import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { ColumnInfo, ObjectDetails, ObjectRef, Scope } from "../../shared/contracts";
import { tlsClientOptions } from "../tls";
import { httpCall, httpOpen, type HttpTarget } from "../http";
import { SqlAdapter, type SqlCursor, type SqlDialectRules, type SqlDriver, type SqlSession } from "./sql-base";
import type { Adapter, AdapterContext } from "./types";

function quote(identifier: string): string {
  return `\`${identifier.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}\``;
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  const text = typeof value === "string" ? value : value instanceof Uint8Array ? Buffer.from(value).toString("latin1") : JSON.stringify(value);
  return `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

const rules: SqlDialectRules = {
  name: "clickhouse",
  quote,
  placeholder: () => {
    throw new Error("ClickHouse statements use rendered literals.");
  },
  table: (ref) => `${ref.database ? `${quote(ref.database)}.` : ""}${quote(ref.name)}`,
  page: (sql, orderBy, limit, offset) => `${sql}${orderBy ? ` ORDER BY ${orderBy}` : ""} LIMIT ${limit} OFFSET ${offset}`,
  asText: (quoted) => `toString(${quoted})`,
  emptyInsert: () => {
    throw new Error("Give at least one column value.");
  },
  bind: (value) => (value !== null && typeof value === "object" && !(value instanceof Uint8Array) ? JSON.stringify(value) : value),
  maxInsertRows: () => 1000,
  truncate: (table) => `TRUNCATE TABLE ${table}`,
  drop: (table, kind) => (kind === "view" ? `DROP VIEW ${table}` : `DROP TABLE ${table}`),
  inlineParams: true,
  builtinLikeEscape: true,
  literal,
};

function asError(body: string): Error {
  return new Error(body.trim().split("\n")[0]?.slice(0, 2000) || "ClickHouse refused the statement.");
}

class ClickhouseDriver implements SqlDriver {
  readonly rules = rules;
  readonly transactional = false;
  private readonly context: AdapterContext;
  private readonly target: HttpTarget;

  constructor(context: AdapterContext) {
    this.context = context;
    const { connection, endpoint } = context;
    if (!endpoint) throw new Error("ClickHouse needs a host.");
    this.target = {
      protocol: connection.tls === "off" ? "http:" : "https:",
      host: endpoint.host,
      port: endpoint.port,
      tls: tlsClientOptions(connection, endpoint),
      headers: { "x-clickhouse-user": connection.user || "default", "x-clickhouse-key": connection.password ?? "" },
    };
  }

  private async call(sql: string, options: { database?: string; readOnly?: boolean; queryId?: string; signal?: AbortSignal } = {}) {
    const params = new URLSearchParams({ wait_end_of_query: "1" });
    const database = options.database || this.context.connection.database;
    if (database) params.set("database", database);
    if (options.readOnly) params.set("readonly", "1");
    if (options.queryId) params.set("query_id", options.queryId);
    const response = await httpCall(this.target, "POST", `/?${params.toString()}`, sql, { contentType: "text/plain", signal: options.signal, timeoutMs: 3600000 });
    if (response.status !== 200) throw asError(response.body);
    return response.body;
  }

  // Reads a result line by line, so a large one stops at the limit instead of loading into memory.
  private async openRows(sql: string, options: { database?: string; readOnly: boolean; queryId: string; signal: AbortSignal }): Promise<SqlCursor> {
    const params = new URLSearchParams({ query_id: options.queryId });
    const database = options.database || this.context.connection.database;
    if (database) params.set("database", database);
    if (options.readOnly) params.set("readonly", "1");
    const response = await httpOpen(this.target, "POST", `/?${params.toString()}`, sql, { signal: options.signal });
    if (response.statusCode !== 200) {
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(chunk as Buffer);
      throw asError(Buffer.concat(chunks).toString("utf8"));
    }
    const lines = createInterface({ input: response, crlfDelay: Infinity })[Symbol.asyncIterator]();
    const readLine = async (): Promise<unknown[] | null> => {
      const item = await lines.next();
      if (item.done) return null;
      try {
        return JSON.parse(item.value) as unknown[];
      } catch {
        // ClickHouse reports an error met part way through as text in the same stream.
        throw asError(item.value);
      }
    };
    const names = ((await readLine()) ?? []) as string[];
    const types = ((await readLine()) ?? []) as string[];
    const columns: ColumnInfo[] = names.map((name, index) => ({ name, type: types[index] ?? null, nullable: types[index]?.startsWith("Nullable") ?? null, defaultValue: null, isKey: false, generated: false }));
    return {
      columns,
      affected: null,
      next: async (count) => {
        const rows: unknown[][] = [];
        while (rows.length < count) {
          const row = await readLine();
          if (!row) break;
          rows.push(row);
        }
        return rows;
      },
      close: async () => {
        response.destroy();
      },
    };
  }

  private session(database: string | undefined, readOnly: boolean): SqlSession {
    const controller = new AbortController();
    let queryId = "";
    return {
      open: async (sql) => {
        queryId = randomUUID();
        const statement = sql.trim().replace(/;+$/, "");
        const isSelect = /^\s*(select|with|show|describe|desc|explain|exists)\b/i.test(statement) && !/\bformat\s+\w+\s*$/i.test(statement);
        if (!isSelect) {
          await this.call(statement, { database, readOnly, queryId, signal: controller.signal });
          return { columns: [], affected: null, next: async () => [], close: async () => undefined };
        }
        return this.openRows(`${statement} FORMAT JSONCompactEachRowWithNamesAndTypes`, { database, readOnly, queryId, signal: controller.signal });
      },
      begin: async () => undefined,
      commit: async () => undefined,
      rollback: async () => undefined,
      cancel: async () => {
        controller.abort();
        if (queryId) await this.call(`KILL QUERY WHERE query_id = ${literal(queryId)} ASYNC`).catch(() => undefined);
      },
      close: async () => undefined,
    };
  }

  async pooled(scope: Scope) {
    return this.session(scope.database, false);
  }

  async dedicated(scope: Scope, readOnly: boolean) {
    return this.session(scope.database, readOnly);
  }

  private async json(sql: string): Promise<unknown[][]> {
    return (JSON.parse(await this.call(`${sql} FORMAT JSONCompact`)) as { data: unknown[][] }).data;
  }

  async serverVersion() {
    return `ClickHouse ${String((await this.json("SELECT version()"))[0]?.[0] ?? "unknown")}`;
  }

  async listDatabases() {
    return (await this.json("SELECT name FROM system.databases ORDER BY name")).map((row) => String(row[0]));
  }

  async listSchemas() {
    return [];
  }

  async listObjects(scope: Scope, pattern: string) {
    const database = scope.database || this.context.connection.database || "default";
    const rows = await this.json(`SELECT name, engine FROM system.tables WHERE database = ${literal(database)}${pattern ? ` AND positionCaseInsensitive(name, ${literal(pattern)}) > 0` : ""} ORDER BY name`);
    return rows.map((row) => ({ name: String(row[0]), kind: String(row[1]).endsWith("View") ? "view" : "table" }));
  }

  async describe(ref: ObjectRef): Promise<ObjectDetails> {
    const database = ref.database || this.context.connection.database || "default";
    const table = (await this.json(`SELECT engine, total_rows, create_table_query FROM system.tables WHERE database = ${literal(database)} AND name = ${literal(ref.name)}`))[0];
    if (!table) throw new Error(`${ref.name} was not found in ${database}.`);
    const columns = await this.json(`SELECT name, type, default_expression, default_kind, is_in_primary_key FROM system.columns WHERE database = ${literal(database)} AND table = ${literal(ref.name)} ORDER BY position`);
    const engine = String(table[0]);
    return {
      name: ref.name,
      kind: engine.endsWith("View") ? "view" : "table",
      columns: columns.map((row) => ({ name: String(row[0]), type: String(row[1]), nullable: String(row[1]).startsWith("Nullable"), defaultValue: row[2] === "" ? null : String(row[2]), isKey: false, generated: row[3] === "MATERIALIZED" || row[3] === "ALIAS" })),
      keyColumns: [],
      keyReason: "ClickHouse rows have no unique key, so rows are added but not edited here. Use ALTER TABLE ... UPDATE from the query box.",
      indexes: [{ name: "primary key", columns: columns.filter((row) => Number(row[4]) === 1).map((row) => String(row[0])), unique: false }],
      foreignKeys: [],
      definition: String(table[2]),
      facts: [
        { label: "Engine", value: engine },
        { label: "Rows", value: String(table[1] ?? "unknown") },
      ],
    };
  }

  async closeAll() {
    return;
  }
}

export async function createClickhouse(context: AdapterContext): Promise<Adapter> {
  return new SqlAdapter(new ClickhouseDriver(context));
}

