import type { ColumnInfo, Filter, ObjectDetails, ObjectPage, ObjectRef, QueryResult, ReadQuery, RowKey, RowPage, Scope, Sort, WriteOp } from "../../shared/contracts";
import { finishRows, fromCell } from "../cells";
import { errorMessage } from "../errors";
import { splitStatements, type SqlDialect } from "../sql-script";
import { type Adapter, type ParsedStatement, requireKey, type RunContext, type StreamBatch, type StreamSource, type WritePlan } from "./types";

export const STREAM_BATCH = 1000;

// An open statement. For a statement with no result set, columns is empty and affected is set.
export interface SqlCursor {
  columns: ColumnInfo[];
  affected: number | null;
  next(count: number): Promise<unknown[][]>;
  close(): Promise<void>;
}

// One database connection. Transactions and session settings belong to it and die with it.
export interface SqlSession {
  open(sql: string, params: unknown[]): Promise<SqlCursor>;
  begin(readOnly: boolean): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface SqlDialectRules {
  name: SqlDialect;
  quote(identifier: string): string;
  placeholder(position: number): string;
  table(ref: ObjectRef): string;
  // Adds paging to a complete SELECT. orderBy is empty when no stable order is known.
  page(sql: string, orderBy: string, limit: number, offset: number): string;
  // SQL text of a column compared as text, for contains and starts.
  asText(quoted: string): string;
  emptyInsert(table: string): string;
  // Converts an edited value to what the driver binds for this column.
  bind(value: unknown, column: ColumnInfo | undefined): unknown;
  truncate(table: string): string;
  // SQL that drops the object. Views are dropped as views.
  drop(table: string, kind: string): string;
  // What a grid SELECT reads. Defaults to *.
  projection?(columns: ColumnInfo[]): string;
  // Names a column in ORDER BY when the projection may hide it behind an alias of the same name.
  orderColumn?(table: string, column: string): string;
  // How many rows one INSERT may carry. Defaults to one row per statement.
  maxInsertRows?(columnCount: number): number;
  // True when LIKE already treats backslash as its escape and has no ESCAPE clause.
  builtinLikeEscape?: boolean;
  // Whether SQL text may bind parameters. ClickHouse takes rendered literals instead.
  inlineParams?: boolean;
  literal?(value: unknown): string;
}

// What each engine must supply. Everything else in the Adapter is shared.
export interface SqlDriver {
  rules: SqlDialectRules;
  // A session sharing the small pool, for statements this plugin writes itself.
  pooled(scope: Scope): Promise<SqlSession>;
  // A connection of its own, for statements the user wrote. It is closed after the run, so a SET or
  // an open transaction in the user's text can never reach another request.
  dedicated(scope: Scope, readOnly: boolean): Promise<SqlSession>;
  serverVersion(): Promise<string>;
  listDatabases(): Promise<string[]>;
  listSchemas(scope: Scope): Promise<string[]>;
  listObjects(scope: Scope, pattern: string): Promise<ObjectPage["objects"]>;
  describe(ref: ObjectRef): Promise<ObjectDetails>;
  closeAll(): Promise<void>;
  // Engines without multi-statement transactions set this to false, and import reports partial rows.
  transactional: boolean;
}

export function ansiQuote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function renderLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const shown = text.length > 500 ? `${text.slice(0, 500)}... (${text.length} characters)` : text;
  return `'${shown.replaceAll("'", "''")}'`;
}

// ! rather than backslash: MySQL reads a backslash in a string literal as an escape of its own, and
// ClickHouse has no ESCAPE clause, so it sets likeEscape to use its built-in backslash.
function likePattern(value: string, op: "contains" | "starts", escape: string): string {
  const special = escape === "!" ? /[!%_]/g : /[\\%_]/g;
  const escaped = value.replace(special, (match) => `${escape}${match}`);
  return op === "contains" ? `%${escaped}%` : `${escaped}%`;
}

const COMPARE: Partial<Record<Filter["op"], string>> = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

export function buildWhere(rules: SqlDialectRules, filters: Filter[], columns: ColumnInfo[], start = 1): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  const add = (value: unknown) => {
    params.push(value);
    return rules.inlineParams ? (rules.literal?.(params.pop()) ?? "NULL") : rules.placeholder(start + params.length - 1);
  };
  for (const item of filters) {
    if (!columns.some((column) => column.name === item.column)) throw new Error(`Unknown column: ${item.column}`);
    const quoted = rules.quote(item.column);
    if (item.op === "null") parts.push(`${quoted} IS NULL`);
    else if (item.op === "notnull") parts.push(`${quoted} IS NOT NULL`);
    else if (item.op === "contains" || item.op === "starts") parts.push(`${rules.asText(quoted)} LIKE ${add(likePattern(item.value, item.op, rules.builtinLikeEscape ? "\\" : "!"))}${rules.builtinLikeEscape ? "" : " ESCAPE '!'"}`);
    else parts.push(`${quoted} ${COMPARE[item.op]} ${add(item.value)}`);
  }
  return { sql: parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "", params };
}

function orderClause(rules: SqlDialectRules, table: string, sort: Sort | null, details: ObjectDetails): string {
  const name = (column: string) => rules.orderColumn?.(table, column) ?? rules.quote(column);
  if (sort) {
    if (!details.columns.some((column) => column.name === sort.column)) throw new Error(`Unknown column: ${sort.column}`);
    return `${name(sort.column)} ${sort.descending ? "DESC" : "ASC"}`;
  }
  return details.keyColumns.map(name).join(", ");
}

function parseOffset(cursor: string | null): number {
  if (cursor === null) return 0;
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid page position.");
  return offset;
}

function mergeColumns(fromResult: ColumnInfo[], details: ObjectDetails): ColumnInfo[] {
  return fromResult.map((column) => {
    const known = details.columns.find((item) => item.name === column.name);
    return known ?? column;
  });
}

const DESCRIBE_TTL_MS = 30000;
// Under the daemon's 30 second limit on an RPC, so the statement stops and the error can say why.
const READ_DEADLINE_MS = 25000;
const WRITE_DEADLINE_MS = 300000;

// A float key cannot be matched reliably: the value shown may not equal the value stored.
function withoutRoundedKeys(details: ObjectDetails): ObjectDetails {
  const rounded = details.keyColumns.filter((name) => /float|double|real/i.test(details.columns.find((column) => column.name === name)?.type ?? ""));
  if (rounded.length === 0) return details;
  return { ...details, keyColumns: [], keyReason: `The key column ${rounded.join(", ")} holds floating point values, which cannot be matched exactly, so rows cannot be changed one at a time.` };
}

export class SqlAdapter implements Adapter {
  private readonly described = new Map<string, { at: number; details: ObjectDetails }>();

  constructor(private readonly driver: SqlDriver) {}

  private get rules(): SqlDialectRules {
    return this.driver.rules;
  }

  async ping() {
    return { serverVersion: await this.driver.serverVersion() };
  }

  listDatabases() {
    return this.driver.listDatabases();
  }

  listSchemas(scope: Scope) {
    return this.driver.listSchemas(scope);
  }

  async listObjects(scope: Scope, options: { pattern: string; cursor: string | null }): Promise<ObjectPage> {
    return { objects: await this.driver.listObjects(scope, options.pattern), nextCursor: null };
  }

  private cacheKey(ref: ObjectRef): string {
    return JSON.stringify([ref.database, ref.schema, ref.name]);
  }

  private projection(details: ObjectDetails): string {
    return this.rules.projection?.(details.columns) ?? "*";
  }

  async describe(ref: ObjectRef): Promise<ObjectDetails> {
    const details = withoutRoundedKeys(await this.driver.describe(ref));
    this.described.set(this.cacheKey(ref), { at: Date.now(), details });
    return details;
  }

  private async cachedDescribe(ref: ObjectRef): Promise<ObjectDetails> {
    const hit = this.described.get(this.cacheKey(ref));
    return hit && Date.now() - hit.at < DESCRIBE_TTL_MS ? hit.details : this.describe(ref);
  }

  private async withPooled<T>(scope: Scope, work: (session: SqlSession) => Promise<T>, deadlineMs = READ_DEADLINE_MS): Promise<T> {
    const session = await this.driver.pooled(scope);
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      void session.cancel().catch(() => undefined);
    }, deadlineMs);
    try {
      return await work(session);
    } catch (error) {
      if (expired) throw new Error(`This took longer than ${Math.round(deadlineMs / 1000)} seconds and was stopped. Try a narrower filter, or use the query box, which has a longer limit.`);
      throw error;
    } finally {
      clearTimeout(timer);
      await session.close();
    }
  }

  private async fetch(session: SqlSession, sql: string, params: unknown[], limit: number) {
    const cursor = await session.open(sql, params);
    try {
      return { columns: cursor.columns, rows: await cursor.next(limit), affected: cursor.affected };
    } finally {
      await cursor.close();
    }
  }

  async read(ref: ObjectRef, query: ReadQuery): Promise<RowPage> {
    const details = await this.cachedDescribe(ref);
    const where = buildWhere(this.rules, query.filters, details.columns);
    const offset = parseOffset(query.cursor);
    // One extra row says whether a next page exists without a count.
    const sql = this.rules.page(`SELECT ${this.projection(details)} FROM ${this.rules.table(ref)}${where.sql}`, orderClause(this.rules, this.rules.table(ref), query.sort, details), query.limit + 1, offset);
    const result = await this.withPooled(ref, (session) => this.fetch(session, sql, where.params, query.limit + 1));
    const finished = finishRows(result.rows, query.limit);
    const cutForSize = finished.rows.length < Math.min(result.rows.length, query.limit);
    return {
      columns: mergeColumns(result.columns, details),
      keyColumns: details.keyColumns,
      keyReason: details.keyReason,
      rows: finished.rows,
      cutCells: finished.cutCells,
      truncated: cutForSize,
      // After a cut for size, the next page starts at the first row left out, so nothing is skipped.
      nextCursor: result.rows.length > query.limit || cutForSize ? String(offset + finished.rows.length) : null,
    };
  }

  async count(ref: ObjectRef, filters: Filter[]): Promise<number> {
    const details = await this.cachedDescribe(ref);
    const where = buildWhere(this.rules, filters, details.columns);
    const result = await this.withPooled(ref, (session) => this.fetch(session, `SELECT COUNT(*) FROM ${this.rules.table(ref)}${where.sql}`, where.params, 1));
    return Number(result.rows[0]?.[0] ?? 0);
  }

  private keyWhere(details: ObjectDetails, ref: ObjectRef, key: RowKey, start: number): { sql: string; params: unknown[]; shown: string } {
    requireKey(ref, details.keyColumns, details.keyReason);
    const names = Object.keys(key);
    const exact = names.length === details.keyColumns.length && details.keyColumns.every((column) => names.includes(column));
    if (!exact) throw new Error(`A row of ${ref.name} is identified by exactly: ${details.keyColumns.join(", ")}.`);
    const params: unknown[] = [];
    const shown: string[] = [];
    const sql = details.keyColumns.map((name) => {
      const value = fromCell(key[name]);
      if (value === null || value === undefined) throw new Error(`The key column ${name} has no value, so the row cannot be identified.`);
      const column = details.columns.find((item) => item.name === name);
      const bound = this.rules.bind(value, column);
      params.push(bound);
      const placeholder = this.rules.inlineParams ? (this.rules.literal?.(bound) ?? "NULL") : this.rules.placeholder(start + params.length - 1);
      shown.push(`${this.rules.quote(name)} = ${renderLiteral(bound)}`);
      return `${this.rules.quote(name)} = ${placeholder}`;
    });
    return { sql: sql.join(" AND "), params: this.rules.inlineParams ? [] : params, shown: shown.join(" AND ") };
  }

  async readRow(ref: ObjectRef, key: RowKey): Promise<RowPage> {
    const details = await this.cachedDescribe(ref);
    const where = this.keyWhere(details, ref, key, 1);
    const result = await this.withPooled(ref, (session) => this.fetch(session, `SELECT ${this.projection(details)} FROM ${this.rules.table(ref)} WHERE ${where.sql}`, where.params, 2));
    const finished = finishRows(result.rows, null, Number.MAX_SAFE_INTEGER);
    return { columns: mergeColumns(result.columns, details), keyColumns: details.keyColumns, keyReason: details.keyReason, rows: finished.rows, cutCells: [], truncated: false, nextCursor: null };
  }

  private checkColumns(details: ObjectDetails, names: string[]): void {
    for (const name of names) if (!details.columns.some((column) => column.name === name)) throw new Error(`Unknown column: ${name}`);
  }

  async planWrite(ref: ObjectRef, op: WriteOp): Promise<WritePlan> {
    // Always fresh: a write must not rely on a key that changed in the last 30 seconds.
    const details = await this.describe(ref);
    const table = this.rules.table(ref);
    const bindValue = (name: string, raw: unknown) =>
      this.rules.bind(
        fromCell(raw),
        details.columns.find((column) => column.name === name),
      );

    if (op.kind === "insert") {
      const names = Object.keys(op.values);
      this.checkColumns(details, names);
      const values = names.map((name) => bindValue(name, op.values[name]));
      const inline = this.rules.inlineParams === true;
      const placeholder = (value: unknown, index: number) => (inline ? (this.rules.literal?.(value) ?? "NULL") : this.rules.placeholder(index + 1));
      const sql = names.length === 0 ? this.rules.emptyInsert(table) : `INSERT INTO ${table} (${names.map((name) => this.rules.quote(name)).join(", ")}) VALUES (${values.map(placeholder).join(", ")})`;
      const preview = names.length === 0 ? sql : `INSERT INTO ${table} (${names.map((name) => this.rules.quote(name)).join(", ")}) VALUES (${values.map(renderLiteral).join(", ")})`;
      return { preview, run: () => this.writeInTransaction(ref, [{ sql, params: inline ? [] : values, expected: null }]) };
    }

    requireKey(ref, details.keyColumns, details.keyReason);

    if (op.kind === "update") {
      const names = Object.keys(op.changes);
      if (names.length === 0) throw new Error("Nothing changed.");
      this.checkColumns(details, names);
      const values = names.map((name) => bindValue(name, op.changes[name]));
      const where = this.keyWhere(details, ref, op.key, values.length + 1);
      const assign = names.map((name, index) => `${this.rules.quote(name)} = ${this.rules.placeholder(index + 1)}`).join(", ");
      const shownAssign = names.map((name, index) => `${this.rules.quote(name)} = ${renderLiteral(values[index])}`).join(", ");
      return {
        preview: `UPDATE ${table} SET ${shownAssign} WHERE ${where.shown}`,
        run: () => this.writeInTransaction(ref, [{ sql: `UPDATE ${table} SET ${assign} WHERE ${where.sql}`, params: [...values, ...where.params], expected: 1 }]),
      };
    }

    const statements = op.keys.map((key) => {
      const where = this.keyWhere(details, ref, key, 1);
      return { sql: `DELETE FROM ${table} WHERE ${where.sql}`, params: where.params, expected: 1, shown: `DELETE FROM ${table} WHERE ${where.shown}` };
    });
    const shown = statements.slice(0, 20).map((statement) => statement.shown);
    if (statements.length > 20) shown.push(`...and ${statements.length - 20} more`);
    return { preview: shown.join("\n"), run: () => this.writeInTransaction(ref, statements) };
  }

  // All of a write lands or none of it does. A key that matches other than one row undoes the write,
  // so a stale or wrong key can never change a different number of rows than the user saw.
  private async writeInTransaction(ref: ObjectRef, statements: { sql: string; params: unknown[]; expected: number | null }[]): Promise<number> {
    return this.withPooled(ref, async (session) => {
      await session.begin(false);
      try {
        let affected = 0;
        for (const statement of statements) {
          const result = await this.fetch(session, statement.sql, statement.params, 1);
          const count = result.affected ?? 0;
          if (statement.expected !== null && count !== statement.expected) throw new Error(count === 0 ? "No row matched its key. Someone may have changed or deleted it; refresh and try again." : `Expected to change ${statement.expected} row, but the key matched ${count}. Nothing was changed.`);
          affected += count;
        }
        await session.commit();
        return affected;
      } catch (error) {
        await session.rollback().catch(() => undefined);
        throw error;
      }
    }, WRITE_DEADLINE_MS);
  }

  async planDestroy(ref: ObjectRef, action: "drop" | "truncate"): Promise<WritePlan> {
    const details = await this.describe(ref);
    const table = this.rules.table(ref);
    const sql = action === "drop" ? this.rules.drop(table, details.kind) : this.rules.truncate(table);
    return {
      preview: sql,
      run: async () => {
        await this.withPooled(ref, (session) => this.fetch(session, sql, [], 1), WRITE_DEADLINE_MS);
        this.described.delete(this.cacheKey(ref));
        return 0;
      },
    };
  }

  async parse(text: string): Promise<ParsedStatement[]> {
    return splitStatements(text, this.rules.name);
  }

  async run(statements: ParsedStatement[], context: RunContext): Promise<QueryResult[]> {
    const session = await this.driver.dedicated(context.scope, context.readOnly);
    const onAbort = () => void session.cancel().catch(() => undefined);
    context.signal.addEventListener("abort", onAbort, { once: true });
    const results: QueryResult[] = [];
    try {
      for (const statement of statements) {
        if (context.signal.aborted) throw new PartialRunError("Cancelled.", results);
        const started = Date.now();
        try {
          // Its own read-only transaction per statement, so nothing a statement does can reach the next.
          if (context.readOnly) await session.begin(true);
          const cursor = await session.open(statement.text, []);
          try {
            // One extra row says the result was cut at the limit.
            const rows = cursor.columns.length > 0 ? await cursor.next(context.limit + 1) : [];
            const finished = finishRows(rows, context.limit);
            results.push({ statement: statement.text, columns: cursor.columns, rows: finished.rows, cutCells: finished.cutCells, truncated: finished.truncated, affected: cursor.affected, durationMs: Date.now() - started, message: null });
          } finally {
            await cursor.close();
            if (context.readOnly) await session.rollback();
          }
        } catch (error) {
          throw new PartialRunError(errorMessage(error), results);
        }
      }
      return results;
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      await session.close().catch(() => undefined);
      this.described.clear();
    }
  }

  async stream(source: StreamSource, signal: AbortSignal, onBatch: (batch: StreamBatch) => Promise<boolean>): Promise<void> {
    let sql: string;
    let params: unknown[] = [];
    let columnsFor: ObjectDetails | null = null;
    if (source.kind === "object") {
      const details = await this.cachedDescribe(source.ref);
      columnsFor = details;
      const where = buildWhere(this.rules, source.filters, details.columns);
      const order = orderClause(this.rules, this.rules.table(source.ref), source.sort, details);
      sql = `SELECT ${this.projection(details)} FROM ${this.rules.table(source.ref)}${where.sql}${order ? ` ORDER BY ${order}` : ""}`;
      params = where.params;
    } else {
      const statements = await this.parse(source.text);
      if (statements.length !== 1) throw new Error("Export runs one statement. This text has " + statements.length + ".");
      const only = statements[0];
      if (!only || only.class !== "read") throw new Error("Export runs read statements only. Run a change from the query box instead.");
      sql = only.text;
    }
    const scope = source.kind === "object" ? source.ref : source.scope;
    // Its own connection, because streaming holds it for the whole export. Read-only when supported.
    const session = await this.driver.dedicated(scope, true);
    const onAbort = () => void session.cancel().catch(() => undefined);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await session.begin(true);
      const cursor = await session.open(sql, params);
      try {
        const columns = columnsFor ? mergeColumns(cursor.columns, columnsFor) : cursor.columns;
        for (;;) {
          if (signal.aborted) throw new Error("Cancelled.");
          const rows = await cursor.next(STREAM_BATCH);
          if (rows.length === 0) return;
          if (!(await onBatch({ columns, rows }))) return;
          if (rows.length < STREAM_BATCH) return;
        }
      } finally {
        await cursor.close();
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      await session.rollback().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
  }

  async importInto(ref: ObjectRef, columns: string[], produce: (insert: (rows: unknown[][]) => Promise<void>) => Promise<void>): Promise<void> {
    const details = await this.describe(ref);
    this.checkColumns(details, columns);
    const known = columns.map((name) => details.columns.find((column) => column.name === name));
    const table = this.rules.table(ref);
    const names = columns.map((name) => this.rules.quote(name)).join(", ");
    const session = await this.driver.dedicated(ref, false);
    try {
      if (this.driver.transactional) await session.begin(false);
      const perStatement = Math.max(1, this.rules.maxInsertRows?.(columns.length) ?? 1);
      await produce(async (rows) => {
        for (let start = 0; start < rows.length; start += perStatement) {
          const params: unknown[] = [];
          const tuples = rows.slice(start, start + perStatement).map((row) => {
            const parts = row.map((value, index) => {
              const bound = this.rules.bind(fromCell(value), known[index]);
              if (this.rules.inlineParams) return this.rules.literal?.(bound) ?? "NULL";
              params.push(bound);
              return this.rules.placeholder(params.length);
            });
            return `(${parts.join(", ")})`;
          });
          const cursor = await session.open(`INSERT INTO ${table} (${names}) VALUES ${tuples.join(", ")}`, params);
          await cursor.close();
        }
      });
      if (this.driver.transactional) await session.commit();
    } catch (error) {
      if (this.driver.transactional) await session.rollback().catch(() => undefined);
      throw error;
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  close() {
    return this.driver.closeAll();
  }
}

// A run that failed part way: the results of the statements before the failure are still real.
export class PartialRunError extends Error {
  constructor(
    message: string,
    readonly results: QueryResult[],
  ) {
    super(message);
  }
}


