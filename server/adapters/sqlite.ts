import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ColumnInfo, ObjectDetails, ObjectRef, Scope } from "../../shared/contracts";
import { ansiQuote, groupRows, SqlAdapter, type SqlCursor, type SqlDialectRules, type SqlDriver, type SqlSession } from "./sql-base";
import type { Adapter, AdapterContext } from "./types";

// node:sqlite blocks its thread, and neither a worker's terminate() nor any API can stop a running query.
// So every database connection is a child process: a slow query cannot stall other requests, and SIGKILL
// is a real cancel. SQLite's journal keeps the file consistent if a write is killed. The script is text
// because a bundled plugin has no separate file to point a child at.
const CHILD_SOURCE = `
const sqlite = require("node:sqlite");
const { file, readOnly } = JSON.parse(process.env.DATAWISE_SQLITE);
const db = new sqlite.DatabaseSync(file, { readOnly });
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA foreign_keys = ON");
if (readOnly) {
  // The file flag still lets statements such as VACUUM INTO write elsewhere. This denies all but reads.
  const c = sqlite.constants;
  const allowed = new Set([c.SQLITE_SELECT, c.SQLITE_READ, c.SQLITE_FUNCTION, c.SQLITE_RECURSIVE, c.SQLITE_TRANSACTION]);
  // Browsing reads the catalog through these. A pragma not named here could change a setting.
  const readPragmas = new Set(["table_info", "table_xinfo", "table_list", "index_list", "index_info", "index_xinfo", "foreign_key_list", "database_list"]);
  db.setAuthorizer((action, name) => (allowed.has(action) || (action === c.SQLITE_PRAGMA && readPragmas.has(String(name).toLowerCase())) ? c.SQLITE_OK : c.SQLITE_DENY));
}
let iterator = null;
let statement = null;
const handlers = {
  open({ sql, params }) {
    statement = db.prepare(sql);
    statement.setReadBigInts(true);
    const columns = statement.columns().map((column) => ({ name: column.name, type: column.type }));
    if (columns.length === 0) {
      const result = statement.run(...params);
      iterator = null;
      return { columns, affected: Number(result.changes) };
    }
    statement.setReturnArrays(true);
    iterator = statement.iterate(...params);
    return { columns, affected: null };
  },
  next({ count }) {
    const rows = [];
    while (iterator && rows.length < count) {
      const item = iterator.next();
      if (item.done) { iterator = null; break; }
      rows.push(item.value);
    }
    return rows;
  },
  closeCursor() { iterator?.return?.(); iterator = null; statement = null; return null; },
  exec({ sql }) { db.exec(sql); return null; },
};
process.on("message", ({ id, op, args }) => {
  try { process.send({ id, value: handlers[op](args) }); }
  catch (error) { process.send({ id, error: String((error && error.message) || error) }); }
});
// A clean close lets SQLite tidy up, so routine closes do not leave -wal and -shm files behind.
process.on("disconnect", () => {
  try { db.close(); } catch {}
  process.exit(0);
});
process.send({ id: 0, value: "ready" });
`;

class SqliteConnection {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private nextId = 1;
  private failure: Error | null = null;

  constructor(file: string, readOnly: boolean) {
    this.child = spawn(process.execPath, ["-e", CHILD_SOURCE], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      // Advanced serialization carries bigint and bytes, which JSON cannot.
      serialization: "advanced",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DATAWISE_SQLITE: JSON.stringify({ file, readOnly }) },
    });
    let stderr = "";
    this.child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 2000) stderr += chunk.toString();
    });
    const fail = (error: Error) => {
      this.failure ??= error;
      for (const waiter of this.pending.values()) waiter.reject(this.failure);
      this.pending.clear();
    };
    this.child.on("message", (raw) => {
      const message = raw as { id: number; value?: unknown; error?: string };
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error !== undefined) waiter?.reject(new Error(message.error));
      else waiter?.resolve(message.value);
    });
    this.child.on("error", fail);
    this.child.on("exit", (_code, signal) => fail(new Error(signal === "SIGKILL" ? "Cancelled." : stderr.trim().split("\n").find((line) => line.includes("Error")) || "SQLite stopped.")));
  }

  // A stopped child cannot answer again. The driver replaces it on the next request.
  get alive(): boolean {
    return this.failure === null;
  }

  call<T>(op: string, args: unknown = {}): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.child.send({ id, op, args });
    });
  }

  // For a cancel: the only way to stop a running query.
  async terminate(): Promise<void> {
    this.child.kill("SIGKILL");
  }

  // For a routine close: the child closes the database and exits. A child busy in a query cannot hear
  // that, so it is stopped after a short wait.
  async close(): Promise<void> {
    if (!this.alive) return;
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    timer.unref();
    this.child.once("exit", () => clearTimeout(timer));
    this.failure = new Error("Closed.");
    if (this.child.connected) this.child.disconnect();
  }
}

const rules: SqlDialectRules = {
  name: "sqlite",
  quote: ansiQuote,
  placeholder: () => "?",
  table: (ref) => ansiQuote(ref.name),
  page: (sql, orderBy, limit, offset) => `${sql}${orderBy ? ` ORDER BY ${orderBy}` : ""} LIMIT ${limit} OFFSET ${offset}`,
  asText: (quoted) => `CAST(${quoted} AS TEXT)`,
  emptyInsert: (table) => `INSERT INTO ${table} DEFAULT VALUES`,
  bind(value) {
    if (typeof value === "boolean") return value ? 1 : 0;
    return value !== null && typeof value === "object" && !(value instanceof Uint8Array) ? JSON.stringify(value) : (value ?? null);
  },
  maxInsertRows: (columnCount) => Math.floor(30000 / columnCount),
  truncate: (table) => `DELETE FROM ${table}`,
  drop: (table, kind) => (kind === "view" ? `DROP VIEW ${table}` : `DROP TABLE ${table}`),
};

class SqliteDriver implements SqlDriver {
  readonly rules = rules;
  readonly transactional = true;
  private shared: SqliteConnection | null = null;
  private sharedBusy: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly readOnly: boolean;
  private readonly sessions = new Set<SqliteConnection>();

  constructor(context: AdapterContext) {
    this.file = context.connection.file;
    // Grid reads share this connection, so a read-only connection must open it read-only too, or a file
    // in a read-only folder could not be browsed at all.
    this.readOnly = context.connection.safety === "read-only";
    if (!this.file) throw new Error("SQLite needs a file path.");
    // Opening a missing path would quietly create an empty database and hide a typing mistake.
    if (!existsSync(this.file)) throw new Error(`No file at ${this.file}.`);
  }

  private session(connection: SqliteConnection, close: () => Promise<void>): SqlSession {
    return {
      open: async (sql, params) => {
        const opened = await connection.call<{ columns: { name: string; type: string | null }[]; affected: number | null }>("open", { sql, params });
        const columns: ColumnInfo[] = opened.columns.map((column) => ({ name: column.name, type: column.type, nullable: null, defaultValue: null, isKey: false, generated: false }));
        const cursor: SqlCursor = {
          columns,
          affected: opened.affected,
          next: (count) => connection.call<unknown[][]>("next", { count }),
          close: () => connection.call<void>("closeCursor").then(() => undefined),
        };
        return cursor;
      },
      begin: (readOnly) => connection.call<void>("exec", { sql: readOnly ? "BEGIN" : "BEGIN IMMEDIATE" }),
      commit: () => connection.call<void>("exec", { sql: "COMMIT" }),
      rollback: () => connection.call<void>("exec", { sql: "ROLLBACK" }),
      cancel: async () => void (await connection.terminate()),
      close,
    };
  }

  private connection(readOnly: boolean) {
    const connection = new SqliteConnection(this.file, readOnly);
    this.sessions.add(connection);
    return connection;
  }

  // SQLite allows one statement at a time per connection, so pooled sessions take turns on one worker.
  async pooled(_scope: Scope): Promise<SqlSession> {
    let release: () => void = () => undefined;
    const previous = this.sharedBusy;
    this.sharedBusy = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    // A deadline stops a slow read by killing the child, so check after waiting for the turn.
    if (!this.shared?.alive) this.shared = this.connection(this.readOnly);
    const shared = this.shared;
    return this.session(shared, async () => release());
  }

  async dedicated(_scope: Scope, readOnly: boolean): Promise<SqlSession> {
    const connection = this.connection(readOnly);
    return this.session(connection, async () => {
      this.sessions.delete(connection);
      await connection.close();
    });
  }

  private async all(sql: string, params: unknown[] = []): Promise<unknown[][]> {
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
    return `SQLite ${String((await this.all("SELECT sqlite_version()"))[0]?.[0] ?? "unknown")}`;
  }

  async listDatabases() {
    return [];
  }

  async listSchemas() {
    return [];
  }

  async listObjects(_scope: Scope, pattern: string) {
    const rows = await this.all("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND (? = '' OR name LIKE '%' || ? || '%') ORDER BY name", [pattern, pattern]);
    return rows.map((row) => ({ name: String(row[0]), kind: String(row[1]) }));
  }

  async describe(ref: ObjectRef): Promise<ObjectDetails> {
    const master = (await this.all("SELECT type, sql FROM sqlite_master WHERE name = ? AND type IN ('table', 'view')", [ref.name]))[0];
    if (!master) throw new Error(`${ref.name} was not found.`);
    const kind = String(master[0]);
    const info = await this.all("SELECT name, type, \"notnull\", dflt_value, pk, hidden FROM pragma_table_xinfo(?)", [ref.name]);
    const primary = info.filter((row) => Number(row[4]) > 0).sort((a, b) => Number(a[4]) - Number(b[4])).map((row) => String(row[0]));
    const indexList = await this.all("SELECT name, \"unique\", partial FROM pragma_index_list(?)", [ref.name]);
    const indexes: ObjectDetails["indexes"] = [];
    let uniqueKey: string[] | null = null;
    for (const row of indexList) {
      const name = String(row[0]);
      const columns = (await this.all("SELECT name FROM pragma_index_info(?) ORDER BY seqno", [name])).map((item) => (item[0] === null ? "(expression)" : String(item[0])));
      indexes.push({ name, columns, unique: Number(row[1]) === 1 });
      const allNotNull = columns.every((column) => info.some((item) => String(item[0]) === column && Number(item[2]) === 1));
      if (uniqueKey === null && Number(row[1]) === 1 && Number(row[2]) === 0 && allNotNull) uniqueKey = columns;
    }
    const fks = await this.all("SELECT id, \"from\", \"table\", \"to\" FROM pragma_foreign_key_list(?) ORDER BY id, seq", [ref.name]);
    const keyColumns = kind === "table" ? (primary.length > 0 ? primary : (uniqueKey ?? [])) : [];
    return {
      name: ref.name,
      kind,
      columns: info.map((row) => {
        const isIntegerKey = primary.length === 1 && Number(row[4]) === 1 && String(row[1]).toUpperCase() === "INTEGER";
        return { name: String(row[0]), type: String(row[1]) || null, nullable: Number(row[2]) !== 1 && Number(row[4]) === 0, defaultValue: row[3] === null ? null : String(row[3]), isKey: keyColumns.includes(String(row[0])), generated: isIntegerKey || Number(row[5]) > 1 };
      }),
      keyColumns,
      keyReason: keyColumns.length > 0 ? null : kind === "table" ? `${ref.name} has no primary key or usable unique index, so its rows cannot be changed one at a time.` : "A view cannot be edited here.",
      indexes,
      foreignKeys: await Promise.all(
        [...groupRows(fks, (row) => String(row[0])).entries()].map(async ([id, rows]) => {
          const target = String(rows[0]?.[2]);
          // A foreign key may leave out the target columns, meaning the target's primary key.
          const stated = rows.map((row) => (row[3] === null ? null : String(row[3])));
          const targetColumns = stated.every((name) => name !== null) ? (stated as string[]) : (await this.all("SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk", [target])).map((row) => String(row[0]));
          return { name: `fk_${id}`, columns: rows.map((row) => String(row[1])), references: `${target} (${targetColumns.join(", ")})`, targetDatabase: null, targetSchema: null, targetTable: target, targetColumns };
        }),
      ),
      definition: master[1] === null ? null : String(master[1]),
      facts: [],
    };
  }

  async closeAll() {
    const all = [...this.sessions];
    this.sessions.clear();
    this.shared = null;
    await Promise.allSettled(all.map((connection) => connection.close()));
  }
}

export async function createSqlite(context: AdapterContext): Promise<Adapter> {
  return new SqlAdapter(new SqliteDriver(context));
}
