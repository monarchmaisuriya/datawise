import type { Connection, FieldPacket, Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { loadDriver } from "../drivers";
import type { ColumnInfo, ObjectDetails, ObjectRef, Scope } from "../../shared/contracts";
import { SqlAdapter, type SqlCursor, type SqlDialectRules, type SqlDriver, type SqlSession } from "./sql-base";
import type { Adapter, AdapterContext } from "./types";

function quote(identifier: string): string {
  return `\`${identifier.replaceAll("`", "``")}\``;
}

const rules: SqlDialectRules = {
  name: "mysql",
  quote,
  placeholder: () => "?",
  table: (ref) => `${ref.database ? `${quote(ref.database)}.` : ""}${quote(ref.name)}`,
  page: (sql, orderBy, limit, offset) => `${sql}${orderBy ? ` ORDER BY ${orderBy}` : ""} LIMIT ${limit} OFFSET ${offset}`,
  asText: (quoted) => `CAST(${quoted} AS CHAR)`,
  emptyInsert: (table) => `INSERT INTO ${table} () VALUES ()`,
  bind: (value) => (value !== null && typeof value === "object" && !(value instanceof Uint8Array) ? JSON.stringify(value) : value),
  maxInsertRows: (columnCount) => Math.floor(60000 / columnCount),
  truncate: (table) => `TRUNCATE TABLE ${table}`,
  drop: (table, kind) => (kind === "view" ? `DROP VIEW ${table}` : `DROP TABLE ${table}`),
};

type RawConnection = { query(sql: string, values: unknown[]): import("node:events").EventEmitter; pause(): void; resume(): void };

function toColumns(fields: FieldPacket[] | undefined): ColumnInfo[] {
  return (fields ?? []).map((field) => ({ name: field.name, type: null, nullable: null, defaultValue: null, isKey: false, generated: false }));
}

class MysqlDriver implements SqlDriver {
  readonly rules = rules;
  readonly transactional = true;
  private poolPromise: Promise<Pool> | null = null;
  private readonly context: AdapterContext;

  constructor(context: AdapterContext) {
    this.context = context;
  }

  private options() {
    const { connection, endpoint } = this.context;
    if (!endpoint) throw new Error("MySQL needs a host.");
    return {
      host: endpoint.host,
      port: endpoint.port,
      user: connection.user || undefined,
      password: connection.password ?? undefined,
      database: connection.database || undefined,
      connectTimeout: 15000,
      // Exact values: dates stay as the text the server sent, and big integers and decimals stay strings.
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      multipleStatements: false,
      rowsAsArray: true,
      // As text: parsing JSON would round large numbers, and an edit would then store the rounded value.
      jsonStrings: true,
      ssl: connection.tls === "off" ? undefined : { rejectUnauthorized: connection.tls === "verify", ca: connection.caCertificate || undefined, servername: endpoint.tlsServername },
    };
  }

  private pool(): Promise<Pool> {
    this.poolPromise ??= loadDriver<typeof import("mysql2/promise")>("mysql2/promise").then((mysql) => mysql.createPool({ ...this.options(), connectionLimit: 3, waitForConnections: true, flags: ["FOUND_ROWS"] }));
    return this.poolPromise;
  }

  private session(connection: Pick<Connection, "query" | "beginTransaction" | "commit" | "rollback">, id: number, release: () => Promise<void>): SqlSession {
    const raw = connection as unknown as { connection: RawConnection };
    return {
      open: (sql, params) => this.openStream(raw.connection, sql, params, id),
      begin: async (readOnly) => void (await connection.query(readOnly ? "START TRANSACTION READ ONLY" : "START TRANSACTION")),
      commit: () => connection.commit(),
      rollback: () => connection.rollback(),
      cancel: async () => {
        const pool = await this.pool();
        await pool.query(`KILL QUERY ${Number(id)}`);
      },
      close: release,
    };
  }

  // Reads row by row and pauses the socket when enough are buffered, so a large result stops at the
  // limit instead of loading into memory.
  private openStream(connection: RawConnection, sql: string, params: unknown[], id: number): Promise<SqlCursor> {
    return new Promise<SqlCursor>((resolveOpen, rejectOpen) => {
      const query = connection.query(sql, params);
      const buffer: unknown[][] = [];
      let columns: ColumnInfo[] = [];
      let affected: number | null = null;
      let finished = false;
      let failure: Error | null = null;
      let waiter: (() => void) | null = null;
      let opened = false;
      let paused = false;
      const wake = () => {
        waiter?.();
        waiter = null;
      };
      const settle = () => {
        if (opened) return;
        opened = true;
        resolveOpen({
          columns,
          affected,
          next: async (count) => {
            const rows: unknown[][] = [];
            while (rows.length < count) {
              if (buffer.length > 0) {
                rows.push(...buffer.splice(0, count - rows.length));
                continue;
              }
              if (failure) throw failure;
              if (finished) break;
              if (paused) {
                paused = false;
                connection.resume();
              }
              await new Promise<void>((resolve) => {
                waiter = resolve;
              });
            }
            return rows;
          },
          close: async () => {
            if (finished) return;
            // The connection cannot be reused until this result ends. Stop it on the server, then drain.
            buffer.length = 0;
            const pool = await this.pool();
            await pool.query(`KILL QUERY ${Number(id)}`).catch(() => undefined);
            if (paused) {
              paused = false;
              connection.resume();
            }
            if (!finished) {
              await new Promise<void>((resolve) => {
                waiter = resolve;
              });
            }
            failure = null;
          },
        });
      };
      query.on("fields", (fields: FieldPacket[] | undefined) => {
        // A statement with no result set can report fields with nothing in them. It then sends a result.
        if (fields && fields.length > 0) {
          columns = toColumns(fields);
          settle();
        }
      });
      query.on("result", (row: unknown) => {
        if (Array.isArray(row)) {
          buffer.push(row);
          if (buffer.length >= 1000 && !paused) {
            paused = true;
            connection.pause();
          }
          wake();
        } else {
          affected = (row as ResultSetHeader).affectedRows ?? 0;
        }
      });
      query.on("error", (error: Error) => {
        failure = error;
        finished = true;
        if (!opened) {
          opened = true;
          rejectOpen(error);
        }
        wake();
      });
      query.on("end", () => {
        finished = true;
        settle();
        wake();
      });
    });
  }

  async pooled(_scope: Scope): Promise<SqlSession> {
    const connection: PoolConnection = await (await this.pool()).getConnection();
    return this.session(connection, connection.threadId, async () => connection.release());
  }

  async dedicated(scope: Scope): Promise<SqlSession> {
    const mysql = await loadDriver<typeof import("mysql2/promise")>("mysql2/promise");
    const connection = await mysql.createConnection({ ...this.options(), database: scope.database || this.context.connection.database || undefined, flags: ["FOUND_ROWS"] });
    connection.on("error", () => undefined);
    return this.session(connection, connection.threadId, () => connection.end());
  }

  private async rows(sql: string, params: unknown[] = []): Promise<unknown[][]> {
    const [rows] = await (await this.pool()).query<RowDataPacket[]>(sql, params);
    return rows as unknown as unknown[][];
  }

  async serverVersion() {
    return String((await this.rows("SELECT VERSION()"))[0]?.[0] ?? "unknown");
  }

  async listDatabases() {
    return (await this.rows("SHOW DATABASES")).map((row) => String(row[0]));
  }

  async listSchemas() {
    return [];
  }

  async listObjects(scope: Scope, pattern: string) {
    const database = scope.database || this.context.connection.database;
    if (!database) return [];
    const rows = await this.rows("SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND (? = '' OR TABLE_NAME LIKE CONCAT('%', ?, '%')) ORDER BY TABLE_NAME", [database, pattern, pattern]);
    return rows.map((row) => ({ name: String(row[0]), kind: String(row[1]).includes("VIEW") ? "view" : "table" }));
  }

  async describe(ref: ObjectRef): Promise<ObjectDetails> {
    const database = ref.database || this.context.connection.database;
    if (!database) throw new Error("Pick a database first.");
    const table = (await this.rows("SELECT TABLE_TYPE, TABLE_ROWS, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", [database, ref.name]))[0];
    if (!table) throw new Error(`${ref.name} was not found in ${database}.`);
    const kind = String(table[0]).includes("VIEW") ? "view" : "table";
    const columns = await this.rows("SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, GENERATION_EXPRESSION FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION", [database, ref.name]);
    const statistics = await this.rows("SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, NULLABLE, SUB_PART FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX", [database, ref.name]);
    const indexes = new Map<string, { name: string; columns: string[]; unique: boolean; usable: boolean }>();
    for (const row of statistics) {
      const name = String(row[0]);
      const entry = indexes.get(name) ?? { name, columns: [], unique: Number(row[2]) === 0, usable: true };
      entry.columns.push(String(row[1] ?? "(expression)"));
      // A prefix index or a nullable column does not identify a row.
      if (row[3] === "YES" || row[4] !== null || row[1] === null) entry.usable = false;
      indexes.set(name, entry);
    }
    const list = [...indexes.values()];
    const key = indexes.get("PRIMARY") ?? list.find((index) => index.unique && index.usable);
    const keyColumns = kind === "table" ? (key?.columns ?? []) : [];
    const fks = await this.rows("SELECT CONSTRAINT_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION), REFERENCED_TABLE_NAME, GROUP_CONCAT(REFERENCED_COLUMN_NAME ORDER BY ORDINAL_POSITION) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL GROUP BY CONSTRAINT_NAME, REFERENCED_TABLE_NAME", [database, ref.name]);
    const definition = await this.rows(`SHOW CREATE ${kind === "view" ? "VIEW" : "TABLE"} ${rules.table({ ...ref, database })}`);
    return {
      name: ref.name,
      kind,
      columns: columns.map((row) => {
        const extra = String(row[4] ?? "").toLowerCase();
        return { name: String(row[0]), type: String(row[1]), nullable: row[2] === "YES", defaultValue: row[3] === null ? null : String(row[3]), isKey: keyColumns.includes(String(row[0])), generated: extra.includes("auto_increment") || extra.includes("generated") };
      }),
      keyColumns,
      keyReason: keyColumns.length > 0 ? null : kind === "table" ? `${ref.name} has no primary key or usable unique index, so its rows cannot be changed one at a time.` : "A view cannot be edited here.",
      indexes: list.map(({ name, columns: names, unique }) => ({ name, columns: names, unique })),
      foreignKeys: fks.map((row) => ({ name: String(row[0]), columns: String(row[1]).split(","), references: `${String(row[2])} (${String(row[3])})` })),
      definition: definition[0] ? String(definition[0][1]) : null,
      facts: [
        { label: "Estimated rows", value: String(table[1] ?? "unknown") },
        { label: "Storage engine", value: String(table[2] ?? "none") },
      ],
    };
  }

  async closeAll() {
    const pool = this.poolPromise;
    this.poolPromise = null;
    if (pool) await (await pool).end();
  }
}

export async function createMysql(context: AdapterContext): Promise<Adapter> {
  return new SqlAdapter(new MysqlDriver(context));
}
