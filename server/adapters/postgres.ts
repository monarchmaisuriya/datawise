import type { ClientConfig, Pool as PgPool, PoolClient, QueryResult as PgResult } from "pg";
import { loadDriver } from "../drivers";
import type { ColumnInfo, ObjectDetails, ObjectRef, Scope } from "../../shared/contracts";
import { ansiQuote, SqlAdapter, type SqlCursor, type SqlDialectRules, type SqlDriver, type SqlSession } from "./sql-base";
import type { Adapter, AdapterContext } from "./types";

// Types kept as the server's own text. Parsing dates would lose microseconds and the written offset, and
// parsing JSON would round large numbers, so an edit of a sibling key would change a value nobody touched.
const TEXT_OIDS = new Set([1082, 1083, 1114, 1184, 1186, 1266, 114, 3802]);

const rules: SqlDialectRules = {
  name: "postgres",
  quote: ansiQuote,
  placeholder: (position) => `$${position}`,
  table: (ref) => `${ref.schema ? `${ansiQuote(ref.schema)}.` : ""}${ansiQuote(ref.name)}`,
  page: (sql, orderBy, limit, offset) => `${sql}${orderBy ? ` ORDER BY ${orderBy}` : ""} LIMIT ${limit} OFFSET ${offset}`,
  asText: (quoted) => `${quoted}::text`,
  emptyInsert: (table) => `INSERT INTO ${table} DEFAULT VALUES`,
  bind(value, column) {
    if (value === null || typeof value !== "object" || value instanceof Uint8Array) return value;
    // A JSON column takes text. An array column takes the array, which pg renders in its own format.
    if (Array.isArray(value) && !column?.type?.startsWith("json")) return value;
    return JSON.stringify(value);
  },
  maxInsertRows: (columnCount) => Math.floor(60000 / columnCount),
  truncate: (table) => `TRUNCATE TABLE ${table}`,
  drop: (table, kind) => (kind === "view" ? `DROP VIEW ${table}` : kind === "materialized view" ? `DROP MATERIALIZED VIEW ${table}` : `DROP TABLE ${table}`),
};

class PgCursor implements SqlCursor {
  constructor(
    readonly columns: ColumnInfo[],
    readonly affected: number | null,
    private readonly source: { read(count: number): Promise<unknown[][]>; close(): Promise<void> } | null,
  ) {}

  next(count: number) {
    return this.source ? this.source.read(count) : Promise.resolve([]);
  }

  close() {
    return this.source ? this.source.close() : Promise.resolve();
  }
}

class PgDriver implements SqlDriver {
  readonly rules = rules;
  readonly transactional = true;
  private readonly pools = new Map<string, PgPool>();
  private readonly context: AdapterContext;

  constructor(context: AdapterContext) {
    this.context = context;
  }

  private config(database: string | undefined): ClientConfig {
    const { connection, endpoint } = this.context;
    if (!endpoint) throw new Error("PostgreSQL needs a host.");
    return {
      host: endpoint.host,
      port: endpoint.port,
      user: connection.user || undefined,
      password: connection.password ?? undefined,
      database: database || connection.database || "postgres",
      connectionTimeoutMillis: 15000,
      application_name: "datawise",
      ssl: connection.tls === "off" ? false : { rejectUnauthorized: connection.tls === "verify", ca: connection.caCertificate || undefined, servername: endpoint.tlsServername },
    };
  }

  private async configWithTypes(database: string | undefined): Promise<ClientConfig> {
    const pg = await loadDriver<typeof import("pg")>("pg");
    const config = this.config(database);
    config.types = {
      getTypeParser: ((oid: number, format?: "text" | "binary") => (TEXT_OIDS.has(oid) ? (value: unknown) => value : pg.types.getTypeParser(oid, format as "text"))) as never,
    };
    return config;
  }

  private async pool(database: string | undefined): Promise<PgPool> {
    const key = database || this.context.connection.database || "postgres";
    let pool = this.pools.get(key);
    if (!pool) {
      const pg = await loadDriver<typeof import("pg")>("pg");
      pool = new pg.Pool({ ...(await this.configWithTypes(key)), max: 3, idleTimeoutMillis: 60000 });
      // An idle connection dying is not a failure of any request. The next request gets a new one.
      pool.on("error", () => undefined);
      this.pools.set(key, pool);
    }
    return pool;
  }

  private session(client: PoolClient | import("pg").Client, release: () => Promise<void>, cancel: () => Promise<void>): SqlSession {
    return {
      async open(sql, params) {
        const Cursor = await loadDriver<typeof import("pg-cursor")>("pg-cursor");
        const cursor = client.query(new Cursor(sql, params, { rowMode: "array" }));
        // The first read reports fields; a statement with no result set ends immediately.
        const first: unknown[][] = await cursor.read(1);
        const result = (cursor as unknown as { _result: PgResult })._result;
        const fields = result.fields ?? [];
        if (fields.length === 0) {
          await cursor.close();
          return new PgCursor([], result.rowCount ?? 0, null);
        }
        const columns: ColumnInfo[] = fields.map((field) => ({ name: field.name, type: null, nullable: null, defaultValue: null, isKey: false, generated: false }));
        let pending = first;
        return new PgCursor(columns, null, {
          async read(count) {
            const head = pending;
            pending = [];
            if (head.length >= count) return head;
            const rest: unknown[][] = await cursor.read(count - head.length);
            return [...head, ...rest];
          },
          close: () => cursor.close(),
        });
      },
      begin: async (readOnly) => void (await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN")),
      commit: async () => void (await client.query("COMMIT")),
      rollback: async () => void (await client.query("ROLLBACK")),
      cancel,
      close: release,
    };
  }

  private async rows<T>(database: string | undefined, sql: string, params: unknown[] = []): Promise<T[]> {
    const pool = await this.pool(database);
    return (await pool.query({ text: sql, values: params })).rows as T[];
  }

  async pooled(scope: Scope): Promise<SqlSession> {
    const client = await (await this.pool(scope.database)).connect();
    const pid = (client as unknown as { processID: number }).processID;
    return this.session(
      client,
      async () => client.release(),
      async () => void (await this.rows(scope.database, "SELECT pg_cancel_backend($1)", [pid])),
    );
  }

  async dedicated(scope: Scope): Promise<SqlSession> {
    const pg = await loadDriver<typeof import("pg")>("pg");
    const client = new pg.Client(await this.configWithTypes(scope.database));
    client.on("error", () => undefined);
    await client.connect();
    if (scope.schema) await client.query(`SET search_path TO ${ansiQuote(scope.schema)}`);
    const pid = (client as unknown as { processID: number }).processID;
    return this.session(
      client,
      () => client.end(),
      async () => void (await this.rows(scope.database, "SELECT pg_cancel_backend($1)", [pid])),
    );
  }

  async serverVersion() {
    return (await this.rows<{ version: string }>(undefined, "SELECT version()"))[0]?.version ?? "unknown";
  }

  async listDatabases() {
    const rows = await this.rows<{ datname: string }>(undefined, "SELECT datname FROM pg_database WHERE datistemplate = false AND datallowconn ORDER BY datname");
    return rows.map((row) => row.datname);
  }

  async listSchemas(scope: Scope) {
    const rows = await this.rows<{ nspname: string }>(scope.database, "SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg_%' ORDER BY nspname = 'information_schema', nspname = 'public' DESC, nspname");
    return rows.map((row) => row.nspname);
  }

  async listObjects(scope: Scope, pattern: string) {
    const rows = await this.rows<{ relname: string; relkind: string }>(
      scope.database,
      `SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f') AND ($2 = '' OR c.relname ILIKE '%' || $2 || '%') ORDER BY c.relname`,
      [scope.schema || "public", pattern],
    );
    const kinds: Record<string, string> = { r: "table", p: "table", v: "view", m: "materialized view", f: "foreign table" };
    return rows.map((row) => ({ name: row.relname, kind: kinds[row.relkind] ?? "table" }));
  }

  async describe(ref: ObjectRef): Promise<ObjectDetails> {
    const schema = ref.schema || "public";
    const db = ref.database;
    const relation = (await this.rows<{ oid: string; relkind: string; estimate: string }>(db, `SELECT c.oid::text, c.relkind, c.reltuples::bigint::text AS estimate FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`, [schema, ref.name]))[0];
    if (!relation) throw new Error(`${ref.name} was not found in ${schema}.`);
    const columnRows = await this.rows<{ attname: string; type: string; notnull: boolean; def: string | null; identity: string; generated: string }>(
      db,
      `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS def, a.attidentity AS identity, a.attgenerated AS generated
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [relation.oid],
    );
    const indexRows = await this.rows<{ name: string; columns: string[]; primary: boolean; unique: boolean; partial: boolean; nullable: boolean }>(
      db,
      `SELECT i.relname AS name, array_agg(a.attname::text ORDER BY k.ord) AS columns, x.indisprimary AS primary, x.indisunique AS unique, x.indpred IS NOT NULL OR bool_or(k.attnum = 0) AS partial, bool_or(NOT a.attnotnull) AS nullable
       FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
       CROSS JOIN LATERAL unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord)
       LEFT JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
       WHERE x.indrelid = $1::oid GROUP BY i.relname, x.indisprimary, x.indisunique, x.indpred ORDER BY x.indisprimary DESC, i.relname`,
      [relation.oid],
    );
    const fkRows = await this.rows<{ name: string; definition: string }>(db, `SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = $1::oid AND contype = 'f' ORDER BY conname`, [relation.oid]);
    const primary = indexRows.find((row) => row.primary);
    // A full, non-partial unique index over non-null columns identifies a row as well as a primary key.
    const unique = indexRows.find((row) => row.unique && !row.partial && !row.nullable);
    const keyColumns = relation.relkind === "r" || relation.relkind === "p" ? (primary?.columns ?? unique?.columns ?? []) : [];
    const kinds: Record<string, string> = { r: "table", p: "table", v: "view", m: "materialized view", f: "foreign table" };
    const kind = kinds[relation.relkind] ?? "table";
    let definition: string | null = null;
    if (relation.relkind === "v" || relation.relkind === "m") definition = (await this.rows<{ d: string }>(db, "SELECT pg_get_viewdef($1::oid, true) AS d", [relation.oid]))[0]?.d ?? null;
    return {
      name: ref.name,
      kind,
      columns: columnRows.map((row) => ({ name: row.attname, type: row.type, nullable: !row.notnull, defaultValue: row.def, isKey: keyColumns.includes(row.attname), generated: row.identity !== "" || row.generated !== "" || (row.def?.startsWith("nextval(") ?? false) })),
      keyColumns,
      keyReason: keyColumns.length > 0 ? null : kind === "table" ? `${ref.name} has no primary key or usable unique index, so its rows cannot be changed one at a time.` : `A ${kind} cannot be edited here.`,
      indexes: indexRows.map((row) => ({ name: row.name, columns: row.columns.map((name) => name ?? "(expression)"), unique: row.unique })),
      foreignKeys: fkRows.map((row) => ({ name: row.name, columns: [], references: row.definition })),
      definition,
      facts: [{ label: "Estimated rows", value: relation.estimate === "-1" ? "not analyzed yet" : relation.estimate }],
    };
  }

  async closeAll() {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.allSettled(pools.map((pool) => pool.end()));
  }
}

export async function createPostgres(context: AdapterContext): Promise<Adapter> {
  return new SqlAdapter(new PgDriver(context));
}
