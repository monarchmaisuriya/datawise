import type { Connection, Pool } from "oracledb";
import { loadDriver } from "../drivers";
import type { ColumnInfo, ObjectDetails, ObjectRef, Scope } from "../../shared/contracts";
import { ansiQuote, groupRows, SqlAdapter, type SqlDialectRules, type SqlDriver, type SqlSession } from "./sql-base";
import type { Adapter, AdapterContext } from "./types";

const rules: SqlDialectRules = {
  name: "oracle",
  quote: ansiQuote,
  placeholder: (position) => `:${position}`,
  table: (ref) => `${ref.schema ? `${ansiQuote(ref.schema)}.` : ""}${ansiQuote(ref.name)}`,
  page: (sql, orderBy, limit, offset) => `${sql}${orderBy ? ` ORDER BY ${orderBy}` : ""} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
  asText: (quoted) => `TO_CHAR(${quoted})`,
  // TO_CHAR with no format uses the session's fixed format, so every digit of a date reaches the grid.
  projection(columns) {
    const isDate = (type: string | null) => /^(date|timestamp)/i.test(type ?? "");
    if (!columns.some((column) => isDate(column.type))) return "*";
    return columns.map((column) => (isDate(column.type) ? `TO_CHAR(${ansiQuote(column.name)}) AS ${ansiQuote(column.name)}` : ansiQuote(column.name))).join(", ");
  },
  // Sorting a date must use the column, not the text alias of the same name.
  orderColumn: (table, column) => `${table}.${ansiQuote(column)}`,
  emptyInsert: (table) => `INSERT INTO ${table} VALUES (DEFAULT)`,
  bind(value) {
    if (typeof value === "boolean") return value ? 1 : 0;
    return value !== null && typeof value === "object" && !(value instanceof Uint8Array) ? JSON.stringify(value) : value;
  },
  truncate: (table) => `TRUNCATE TABLE ${table}`,
  drop: (table, kind) => (kind === "view" ? `DROP VIEW ${table}` : `DROP TABLE ${table}`),
};

// The query box cannot rewrite a person's SELECT, so a date there has the driver's millisecond precision.
function wallClock(value: Date): string {
  const two = (part: number) => String(part).padStart(2, "0");
  return `${value.getFullYear()}-${two(value.getMonth() + 1)}-${two(value.getDate())} ${two(value.getHours())}:${two(value.getMinutes())}:${two(value.getSeconds())}.${String(value.getMilliseconds()).padStart(3, "0")}`;
}

// A fixed text form for dates, so what the grid shows is what an edit can write back.
const SESSION_SETUP = "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS' NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF' NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM' NLS_NUMERIC_CHARACTERS = '.,'";

class OracleDriver implements SqlDriver {
  readonly rules = rules;
  readonly transactional = true;
  private poolPromise: Promise<Pool> | null = null;
  private readonly context: AdapterContext;

  constructor(context: AdapterContext) {
    this.context = context;
  }

  private async library() {
    const oracledb = await loadDriver<typeof import("oracledb")>("oracledb");
    // Numbers as text keep full precision; a JavaScript number would round large values. CLOB covers NCLOB.
    // Dates are not listed: this driver turns them into JavaScript date text, which drops microseconds and
    // cannot be written back. Table reads use TO_CHAR instead, in the projection below.
    oracledb.fetchAsString = [oracledb.DB_TYPE_NUMBER, oracledb.DB_TYPE_CLOB] as never;
    oracledb.fetchAsBuffer = [oracledb.DB_TYPE_BLOB];
    return oracledb;
  }

  private target() {
    const { connection, endpoint } = this.context;
    if (!endpoint) throw new Error("Oracle needs a host.");
    const service = connection.serviceName || connection.database || "FREEPDB1";
    const protocol = connection.tls === "off" ? "tcp" : "tcps";
    const security = connection.tls === "off" ? "" : `(SECURITY=(SSL_SERVER_DN_MATCH=${connection.tls === "verify" ? "yes" : "no"}))`;
    return {
      user: connection.user,
      password: connection.password ?? undefined,
      connectString: `(DESCRIPTION=(ADDRESS=(PROTOCOL=${protocol})(HOST=${endpoint.host})(PORT=${endpoint.port}))(CONNECT_DATA=(SERVICE_NAME=${service}))${security})`,
    };
  }

  private pool(): Promise<Pool> {
    this.poolPromise ??= this.library().then((oracledb) => oracledb.createPool({ ...this.target(), poolMin: 0, poolMax: 3, poolTimeout: 60, sessionCallback: (connection: Connection, _tag: string, done: (error?: Error) => void) => void connection.execute(SESSION_SETUP).then(() => done(), done) } as never));
    return this.poolPromise;
  }

  private session(connection: Connection, close: () => Promise<void>): SqlSession {
    let inTransaction = false;
    return {
      open: async (sql, params) => {
        const oracledb = await this.library();
        const result = await connection.execute(sql, params as never, { resultSet: true, outFormat: oracledb.OUT_FORMAT_ARRAY, autoCommit: !inTransaction });
        const columns: ColumnInfo[] = (result.metaData ?? []).map((column) => ({ name: column.name, type: column.dbTypeName ?? null, nullable: column.nullable ?? null, defaultValue: null, isKey: false, generated: false }));
        const resultSet = result.resultSet;
        if (!resultSet) return { columns: [], affected: result.rowsAffected ?? 0, next: async () => [], close: async () => undefined };
        return {
          columns,
          affected: null,
          next: async (count) => ((await resultSet.getRows(count)) as unknown[][]).map((row) => row.map((value) => (value instanceof Date ? wallClock(value) : value))),
          close: () => resultSet.close(),
        };
      },
      begin: async (readOnly) => {
        inTransaction = true;
        if (readOnly) await connection.execute("SET TRANSACTION READ ONLY");
      },
      commit: async () => {
        await connection.commit();
        inTransaction = false;
      },
      rollback: async () => {
        await connection.rollback();
        inTransaction = false;
      },
      cancel: () => connection.break(),
      close,
    };
  }

  async pooled(_scope: Scope): Promise<SqlSession> {
    // Grid statements name their schema, so a pooled connection carries no session state.
    const connection = await (await this.pool()).getConnection();
    return this.session(connection, () => connection.close());
  }

  async dedicated(scope: Scope): Promise<SqlSession> {
    const oracledb = await this.library();
    const connection = await oracledb.getConnection(this.target());
    await connection.execute(SESSION_SETUP);
    if (scope.schema) await connection.execute(`ALTER SESSION SET CURRENT_SCHEMA = ${ansiQuote(scope.schema)}`);
    return this.session(connection, () => connection.close());
  }

  private async rows(sql: string, params: unknown[] = []): Promise<unknown[][]> {
    const session = await this.pooled({ connectionId: "" });
    try {
      const cursor = await session.open(sql, params);
      const rows = await cursor.next(100000);
      await cursor.close();
      return rows;
    } finally {
      await session.close();
    }
  }

  async serverVersion() {
    return String((await this.rows("SELECT banner FROM v$version"))[0]?.[0] ?? "Oracle");
  }

  async listDatabases() {
    return [];
  }

  async listSchemas() {
    const current = this.context.connection.user.toUpperCase();
    const rows = await this.rows("SELECT username FROM all_users WHERE oracle_maintained = 'N' OR username = :1 ORDER BY CASE WHEN username = :2 THEN 0 ELSE 1 END, username", [current, current]);
    return rows.map((row) => String(row[0]));
  }

  async listObjects(scope: Scope, pattern: string) {
    const owner = scope.schema || this.context.connection.user.toUpperCase();
    const rows = await this.rows(
      "SELECT object_name, object_type FROM all_objects WHERE owner = :1 AND object_type IN ('TABLE','VIEW') AND (:2 IS NULL OR UPPER(object_name) LIKE '%' || UPPER(:3) || '%') AND object_name NOT LIKE 'BIN$%' ORDER BY object_name",
      [owner, pattern || null, pattern || null],
    );
    return rows.map((row) => ({ name: String(row[0]), kind: String(row[1]).toLowerCase() }));
  }

  async describe(ref: ObjectRef): Promise<ObjectDetails> {
    const owner = ref.schema || this.context.connection.user.toUpperCase();
    const object = (await this.rows("SELECT object_type FROM all_objects WHERE owner = :1 AND object_name = :2 AND object_type IN ('TABLE','VIEW')", [owner, ref.name]))[0];
    if (!object) throw new Error(`${ref.name} was not found in ${owner}.`);
    const kind = String(object[0]).toLowerCase();
    const columns = await this.rows("SELECT column_name, data_type, nullable, data_default, identity_column, virtual_column FROM all_tab_cols WHERE owner = :1 AND table_name = :2 AND hidden_column = 'NO' ORDER BY column_id", [owner, ref.name]);
    const constraints = await this.rows(
      "SELECT c.constraint_name, c.constraint_type, cc.column_name, r.table_name, c.status FROM all_constraints c JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name LEFT JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name WHERE c.owner = :1 AND c.table_name = :2 AND c.constraint_type IN ('P','R','U') ORDER BY c.constraint_name, cc.position",
      [owner, ref.name],
    );
    const indexRows = await this.rows("SELECT i.index_name, ic.column_name, i.uniqueness FROM all_indexes i JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name WHERE i.table_owner = :1 AND i.table_name = :2 ORDER BY i.index_name, ic.column_position", [owner, ref.name]);
    const nullable = new Map(columns.map((row) => [String(row[0]), row[2] === "Y"]));
    const primary = constraints.filter((row) => row[1] === "P").map((row) => String(row[2]));
    const uniqueGroups = new Map<string, string[]>();
    for (const row of constraints) if (row[1] === "U" && row[4] === "ENABLED") uniqueGroups.set(String(row[0]), [...(uniqueGroups.get(String(row[0])) ?? []), String(row[2])]);
    const unique = [...uniqueGroups.values()].find((names) => names.every((name) => nullable.get(name) === false));
    const keyColumns = kind === "table" ? (primary.length > 0 ? primary : (unique ?? [])) : [];
    const fkRows = await this.rows(
      "SELECT c.constraint_name, cc.column_name, r.owner, r.table_name, rc.column_name FROM all_constraints c JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name AND rc.position = cc.position WHERE c.owner = :1 AND c.table_name = :2 AND c.constraint_type = 'R' ORDER BY c.constraint_name, cc.position",
      [owner, ref.name],
    );
    const indexes = new Map<string, { name: string; columns: string[]; unique: boolean }>();
    for (const row of indexRows) {
      const entry = indexes.get(String(row[0])) ?? { name: String(row[0]), columns: [], unique: row[2] === "UNIQUE" };
      entry.columns.push(String(row[1]));
      indexes.set(String(row[0]), entry);
    }
    return {
      name: ref.name,
      kind,
      columns: columns.map((row) => ({ name: String(row[0]), type: String(row[1]), nullable: row[2] === "Y", defaultValue: row[3] === null ? null : String(row[3]).trim(), isKey: keyColumns.includes(String(row[0])), generated: row[4] === "YES" || row[5] === "YES" })),
      keyColumns,
      keyReason: keyColumns.length > 0 ? null : kind === "table" ? `${ref.name} has no primary key or usable unique constraint, so its rows cannot be changed one at a time.` : "A view cannot be edited here.",
      indexes: [...indexes.values()],
      foreignKeys: [...groupRows(fkRows, (row) => String(row[0])).entries()].map(([name, rows]) => ({ name, columns: rows.map((row) => String(row[1])), references: `${String(rows[0]?.[3])} (${rows.map((row) => String(row[4])).join(", ")})`, targetDatabase: null, targetSchema: String(rows[0]?.[2]), targetTable: String(rows[0]?.[3]), targetColumns: rows.map((row) => String(row[4])) })),
      definition: null,
      facts: [{ label: "Owner", value: owner }],
    };
  }

  async closeAll() {
    const pool = this.poolPromise;
    this.poolPromise = null;
    if (pool) await (await pool).close(0);
  }
}

export async function createOracle(context: AdapterContext): Promise<Adapter> {
  return new SqlAdapter(new OracleDriver(context));
}
