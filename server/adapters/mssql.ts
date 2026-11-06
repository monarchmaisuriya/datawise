import type { ConnectionPool, config as MssqlConfig, Request, Transaction } from "mssql";
import { loadDriver } from "../drivers";
import type { ColumnInfo, ObjectDetails, ObjectRef, Scope } from "../../shared/contracts";
import { SqlAdapter, type SqlCursor, type SqlDialectRules, type SqlDriver, type SqlSession } from "./sql-base";
import type { Adapter, AdapterContext } from "./types";

function quote(identifier: string): string {
  return `[${identifier.replaceAll("]", "]]")}]`;
}

// Text forms that keep every digit. The default CAST drops seconds from datetime and rounds money.
const EXACT_AS_TEXT: Record<string, (column: string) => string> = {
  decimal: (column) => `CAST(${column} AS VARCHAR(60))`,
  numeric: (column) => `CAST(${column} AS VARCHAR(60))`,
  money: (column) => `CONVERT(VARCHAR(40), ${column}, 2)`,
  smallmoney: (column) => `CONVERT(VARCHAR(40), ${column}, 2)`,
  datetime: (column) => `CONVERT(VARCHAR(40), ${column}, 126)`,
  smalldatetime: (column) => `CONVERT(VARCHAR(40), ${column}, 126)`,
  datetime2: (column) => `CONVERT(VARCHAR(40), ${column}, 126)`,
  datetimeoffset: (column) => `CONVERT(VARCHAR(40), ${column}, 126)`,
  time: (column) => `CONVERT(VARCHAR(40), ${column}, 114)`,
};

const rules: SqlDialectRules = {
  name: "mssql",
  quote,
  placeholder: (position) => `@p${position}`,
  table: (ref) => `${ref.schema ? `${quote(ref.schema)}.` : ""}${quote(ref.name)}`,
  // OFFSET needs an ORDER BY in T-SQL. SELECT NULL gives an unstable order only when no key exists.
  page: (sql, orderBy, limit, offset) => `${sql} ORDER BY ${orderBy || "(SELECT NULL)"} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
  asText: (quoted) => `CAST(${quoted} AS NVARCHAR(MAX))`,
  emptyInsert: (table) => `INSERT INTO ${table} DEFAULT VALUES`,
  bind: (value) => (value !== null && typeof value === "object" && !(value instanceof Uint8Array) ? JSON.stringify(value) : value),
  maxInsertRows: (columnCount) => Math.min(1000, Math.floor(2000 / columnCount)),
  truncate: (table) => `TRUNCATE TABLE ${table}`,
  drop: (table, kind) => (kind === "view" ? `DROP VIEW ${table}` : `DROP TABLE ${table}`),
  // The driver turns these into a JavaScript number or Date, which rounds them. As text they stay exact.
  projection(columns) {
    if (!columns.some((column) => EXACT_AS_TEXT[column.type ?? ""])) return "*";
    return columns
      .map((column) => {
        const exact = EXACT_AS_TEXT[column.type ?? ""];
        return exact ? `${exact(quote(column.name))} AS ${quote(column.name)}` : quote(column.name);
      })
      .join(", ");
  },
  // Sorting a date or a price must use the column, not the text alias of the same name.
  orderColumn: (table, column) => `${table}.${quote(column)}`,
};

class MssqlDriver implements SqlDriver {
  readonly rules = rules;
  readonly transactional = true;
  private readonly pools = new Map<string, Promise<ConnectionPool>>();
  private readonly context: AdapterContext;

  constructor(context: AdapterContext) {
    this.context = context;
  }

  private options(database: string | undefined, max: number): MssqlConfig {
    const { connection, endpoint } = this.context;
    if (!endpoint) throw new Error("SQL Server needs a host.");
    return {
      server: endpoint.host,
      port: endpoint.port,
      user: connection.user || undefined,
      password: connection.password ?? undefined,
      database: database || connection.database || undefined,
      connectionTimeout: 15000,
      requestTimeout: 0,
      arrayRowMode: true,
      pool: { max, min: 0, idleTimeoutMillis: 60000 },
      options: { encrypt: connection.tls !== "off", trustServerCertificate: connection.tls !== "verify", serverName: endpoint.tlsServername, useUTC: true, appName: "datawise" },
    } as MssqlConfig;
  }

  private pool(database: string | undefined): Promise<ConnectionPool> {
    const key = database || this.context.connection.database || "";
    let pool = this.pools.get(key);
    if (!pool) {
      pool = loadDriver<typeof import("mssql")>("mssql").then((sql) => {
        const instance = new sql.ConnectionPool(this.options(database, 3));
        instance.on("error", () => undefined);
        return instance.connect();
      });
      this.pools.set(key, pool);
      pool.catch(() => this.pools.delete(key));
    }
    return pool;
  }

  private session(pool: ConnectionPool, closePool: () => Promise<void>): SqlSession {
    let transaction: Transaction | null = null;
    let active: Request | null = null;
    return {
      open: async (text, params) => {
        const sql = await loadDriver<typeof import("mssql")>("mssql");
        const request = transaction ? new sql.Request(transaction) : new sql.Request(pool);
        for (const [index, value] of params.entries()) request.input(`p${index + 1}`, value);
        return openStream(request, text, (value) => {
          active = value;
        });
      },
      begin: async (readOnly) => {
        const sql = await loadDriver<typeof import("mssql")>("mssql");
        transaction = new sql.Transaction(pool);
        await transaction.begin();
        if (readOnly) return;
      },
      commit: async () => {
        await transaction?.commit();
        transaction = null;
      },
      rollback: async () => {
        const current = transaction;
        transaction = null;
        await current?.rollback();
      },
      cancel: async () => {
        active?.cancel();
      },
      close: closePool,
    };
  }

  async pooled(scope: Scope): Promise<SqlSession> {
    return this.session(await this.pool(scope.database), async () => undefined);
  }

  async dedicated(scope: Scope): Promise<SqlSession> {
    const sql = await loadDriver<typeof import("mssql")>("mssql");
    const pool = new sql.ConnectionPool(this.options(scope.database, 1));
    pool.on("error", () => undefined);
    await pool.connect();
    return this.session(pool, () => pool.close());
  }

  private async rows(database: string | undefined, text: string, params: unknown[] = []): Promise<unknown[][]> {
    const session = await this.pooled({ connectionId: "", database });
    const cursor = await session.open(text, params);
    const rows = await cursor.next(100000);
    await cursor.close();
    return rows;
  }

  async serverVersion() {
    return String((await this.rows(undefined, "SELECT @@VERSION"))[0]?.[0] ?? "unknown").split("\n")[0] ?? "unknown";
  }

  async listDatabases() {
    return (await this.rows(undefined, "SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name")).map((row) => String(row[0]));
  }

  async listSchemas(scope: Scope) {
    return (await this.rows(scope.database, "SELECT s.name FROM sys.schemas s WHERE s.schema_id < 16384 AND s.name NOT IN ('guest','INFORMATION_SCHEMA','sys') ORDER BY CASE WHEN s.name = 'dbo' THEN 0 ELSE 1 END, s.name")).map((row) => String(row[0]));
  }

  async listObjects(scope: Scope, pattern: string) {
    const rows = await this.rows(scope.database, "SELECT o.name, o.type FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = @p1 AND o.type IN ('U','V') AND (@p2 = '' OR o.name LIKE '%' + @p2 + '%') ORDER BY o.name", [scope.schema || "dbo", pattern]);
    return rows.map((row) => ({ name: String(row[0]), kind: String(row[1]).trim() === "V" ? "view" : "table" }));
  }

  async describe(ref: ObjectRef): Promise<ObjectDetails> {
    const schema = ref.schema || "dbo";
    const qualified = `${quote(schema)}.${quote(ref.name)}`;
    const db = ref.database;
    const object = (await this.rows(db, "SELECT o.object_id, o.type FROM sys.objects o WHERE o.object_id = OBJECT_ID(@p1)", [qualified]))[0];
    if (!object) throw new Error(`${ref.name} was not found in ${schema}.`);
    const objectId = object[0];
    const kind = String(object[1]).trim() === "V" ? "view" : "table";
    const columns = await this.rows(db, `SELECT c.name, TYPE_NAME(c.user_type_id), c.max_length, c.is_nullable, OBJECT_DEFINITION(c.default_object_id), c.is_identity, c.is_computed
      FROM sys.columns c WHERE c.object_id = @p1 ORDER BY c.column_id`, [objectId]);
    const indexRows = await this.rows(db, `SELECT i.name, c.name, i.is_unique, i.is_primary_key, c.is_nullable, i.has_filter FROM sys.indexes i
      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE i.object_id = @p1 ORDER BY i.is_primary_key DESC, i.name, ic.key_ordinal`, [objectId]);
    const indexes = new Map<string, { name: string; columns: string[]; unique: boolean; primary: boolean; usable: boolean }>();
    for (const row of indexRows) {
      const name = String(row[0]);
      const entry = indexes.get(name) ?? { name, columns: [], unique: Boolean(row[2]), primary: Boolean(row[3]), usable: !row[5] };
      entry.columns.push(String(row[1]));
      if (row[4]) entry.usable = false;
      indexes.set(name, entry);
    }
    const list = [...indexes.values()];
    const key = list.find((index) => index.primary) ?? list.find((index) => index.unique && index.usable);
    const keyColumns = kind === "table" ? (key?.columns ?? []) : [];
    const fks = await this.rows(db, `SELECT f.name, COL_NAME(fc.parent_object_id, fc.parent_column_id), OBJECT_NAME(f.referenced_object_id), COL_NAME(fc.referenced_object_id, fc.referenced_column_id)
      FROM sys.foreign_keys f JOIN sys.foreign_key_columns fc ON fc.constraint_object_id = f.object_id WHERE f.parent_object_id = @p1`, [objectId]);
    const definition = kind === "view" ? String((await this.rows(db, "SELECT OBJECT_DEFINITION(@p1)", [objectId]))[0]?.[0] ?? "") : null;
    const estimate = await this.rows(db, "SELECT SUM(row_count) FROM sys.dm_db_partition_stats WHERE object_id = @p1 AND index_id IN (0,1)", [objectId]).catch(() => []);
    return {
      name: ref.name,
      kind,
      columns: columns.map((row) => ({ name: String(row[0]), type: String(row[1]), nullable: Boolean(row[3]), defaultValue: row[4] === null ? null : String(row[4]), isKey: keyColumns.includes(String(row[0])), generated: Boolean(row[5]) || Boolean(row[6]) })),
      keyColumns,
      keyReason: keyColumns.length > 0 ? null : kind === "table" ? `${ref.name} has no primary key or usable unique index, so its rows cannot be changed one at a time.` : "A view cannot be edited here.",
      indexes: list.map(({ name, columns: names, unique }) => ({ name, columns: names, unique })),
      foreignKeys: fks.map((row) => ({ name: String(row[0]), columns: [String(row[1])], references: `${String(row[2])} (${String(row[3])})` })),
      definition,
      facts: estimate[0]?.[0] === undefined ? [] : [{ label: "Estimated rows", value: String(estimate[0][0]) }],
    };
  }

  async closeAll() {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.allSettled(pools.map(async (pool) => (await pool).close()));
  }
}

// Streams rows and pauses when enough are buffered, so a huge result does not load into memory.
function openStream(request: Request, text: string, setActive: (request: Request) => void): Promise<SqlCursor> {
  request.stream = true;
  (request as unknown as { arrayRowMode: boolean }).arrayRowMode = true;
  setActive(request);
  return new Promise<SqlCursor>((resolveOpen, rejectOpen) => {
    let columns: ColumnInfo[] = [];
    const buffer: unknown[][] = [];
    let finished = false;
    let failure: Error | null = null;
    let waiter: (() => void) | null = null;
    let opened = false;
    let setsSeen = 0;
    let affected: number | null = null;
    const wake = () => {
      waiter?.();
      waiter = null;
    };
    const cursor = (): SqlCursor => ({
      columns,
      affected,
      async next(count) {
        const rows: unknown[][] = [];
        while (rows.length < count) {
          if (buffer.length > 0) {
            rows.push(...buffer.splice(0, count - rows.length));
            continue;
          }
          if (failure) throw failure;
          if (finished) break;
          request.resume();
          await new Promise<void>((resolve) => {
            waiter = resolve;
          });
        }
        return rows;
      },
      async close() {
        if (!finished) {
          request.cancel();
          await new Promise<void>((resolve) => {
            if (finished) resolve();
            else waiter = resolve;
          });
        }
      },
    });
    const open = () => {
      if (!opened) {
        opened = true;
        resolveOpen(cursor());
      }
    };
    request.on("recordset", (meta: Record<string, { name: string; type?: { name?: string } }> | { name: string }[]) => {
      setsSeen += 1;
      if (setsSeen > 1) return;
      const list = Array.isArray(meta) ? meta : Object.values(meta);
      columns = list.map((column) => ({ name: column.name, type: null, nullable: null, defaultValue: null, isKey: false, generated: false }));
      open();
    });
    request.on("row", (row: unknown[]) => {
      if (setsSeen > 1) return;
      buffer.push(row);
      if (buffer.length >= 1000) request.pause();
      wake();
    });
    request.on("error", (error: Error) => {
      // Stopping early on purpose is reported as an abort, which is not a failure of the statement.
      const cancelled = (error as { code?: string }).code === "ECANCEL" && opened;
      if (!cancelled) failure = error;
      // The connection stays busy until "done". Reporting the error sooner would let the caller roll
      // back while the request is still running, and the driver refuses that.
      wake();
    });
    request.on("done", (result: { rowsAffected?: number[] }) => {
      finished = true;
      // A trigger's counts come first, and the statement's own count is last.
      if (setsSeen === 0) affected = (result.rowsAffected ?? []).at(-1) ?? 0;
      if (!opened && failure) {
        opened = true;
        rejectOpen(failure);
      } else open();
      wake();
    });
    request.query(text);
  });
}

export async function createMssql(context: AdapterContext): Promise<Adapter> {
  return new SqlAdapter(new MssqlDriver(context));
}
