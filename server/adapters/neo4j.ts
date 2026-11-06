import type { Driver, Session } from "neo4j-driver";
import type { Filter, ObjectDetails, ObjectPage, ObjectRef, QueryResult, ReadQuery, RowKey, RowPage, Scope, Sort, WriteOp } from "../../shared/contracts";
import { finishRows } from "../cells";
import { loadDriver } from "../drivers";
import { errorMessage } from "../errors";
import { splitStatements } from "../sql-script";
import { PartialRunError, renderLiteral, STREAM_BATCH } from "./sql-base";
import type { Adapter, AdapterContext, ParsedStatement, RunContext, StreamBatch, StreamSource, WritePlan } from "./types";

type Neo4j = typeof import("neo4j-driver").default;

const ID_COLUMN = "elementId";
// Cypher clauses that can write. A statement holding one of these anywhere counts as a write, and a
// CALL can write too, so a read-only session is the second layer for anything missed.
const WRITE_CLAUSES = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP|DETACH|LOAD\s+CSV|FOREACH|CALL|GRANT|DENY|REVOKE|ALTER|START|STOP|TERMINATE|ENABLE|RENAME)\b/i;

function quoteLabel(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``;
}

// Strings and comments have to be read together, left to right: // inside a string is not a comment,
// and a quote inside a comment does not start a string.
function codeOnly(text: string): string {
  let code = "";
  let index = 0;
  while (index < text.length) {
    const pair = text.slice(index, index + 2);
    const char = text[index] ?? "";
    if (pair === "//") {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end;
    } else if (pair === "/*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else if (char === "'" || char === '"' || char === "`") {
      let cursor = index + 1;
      while (cursor < text.length && text[cursor] !== char) cursor += char !== "`" && text[cursor] === "\\" ? 2 : 1;
      code += " '' ";
      index = cursor + 1;
    } else {
      code += char;
      index += 1;
    }
  }
  return code;
}

export function classifyCypher(text: string): "read" | "write" {
  const code = codeOnly(text);
  return WRITE_CLAUSES.test(code) ? "write" : /^\s*(MATCH|OPTIONAL|RETURN|WITH|UNWIND|EXPLAIN|PROFILE|SHOW)\b/i.test(code) ? "read" : "write";
}

// The driver sends every JavaScript number as a float, which would change an integer property's type.
function integersFor(value: unknown, neo4j: Neo4j): unknown {
  if (typeof value === "number" && Number.isSafeInteger(value)) return neo4j.int(value);
  if (Array.isArray(value)) return value.map((item) => integersFor(item, neo4j));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, integersFor(item, neo4j)]));
  return value;
}

class Neo4jAdapter implements Adapter {
  private driverPromise: Promise<{ driver: Driver; neo4j: Neo4j }> | null = null;
  private readonly context: AdapterContext;

  constructor(context: AdapterContext) {
    this.context = context;
  }

  private get(): Promise<{ driver: Driver; neo4j: Neo4j }> {
    this.driverPromise ??= (async () => {
      const { connection, endpoint } = this.context;
      if (!endpoint) throw new Error("Neo4j needs a host.");
      const module = await loadDriver<{ default?: Neo4j } & Neo4j>("neo4j-driver");
      const neo4j = module.default ?? module;
      // bolt:// talks to this host only. neo4j:// would follow the cluster's addresses out of a tunnel.
      const scheme = connection.tls === "off" ? "bolt" : connection.tls === "verify" ? "bolt+s" : "bolt+ssc";
      const driver = neo4j.driver(`${scheme}://${endpoint.host}:${endpoint.port}`, neo4j.auth.basic(connection.user || "neo4j", connection.password ?? ""), { connectionTimeout: 15000, maxConnectionPoolSize: 5, disableLosslessIntegers: false, userAgent: "datawise" });
      return { driver, neo4j };
    })();
    return this.driverPromise;
  }

  private databaseName(database: string | undefined): string | undefined {
    return database || this.context.connection.database || undefined;
  }

  private async withSession<T>(database: string | undefined, mode: "READ" | "WRITE", work: (session: Session, neo4j: Neo4j) => Promise<T>): Promise<T> {
    const { driver, neo4j } = await this.get();
    const session = driver.session({ database: this.databaseName(database), defaultAccessMode: mode === "READ" ? neo4j.session.READ : neo4j.session.WRITE });
    try {
      return await work(session, neo4j);
    } finally {
      await session.close();
    }
  }

  // Graph values become plain JSON. Integers beyond the safe range stay text.
  private plain(value: unknown, neo4j: Neo4j): unknown {
    if (value === null || value === undefined) return null;
    if (neo4j.isInt(value)) return neo4j.integer.inSafeRange(value) ? neo4j.integer.toNumber(value) : neo4j.integer.toString(value);
    if (Array.isArray(value)) return value.map((item) => this.plain(item, neo4j));
    if (value instanceof Uint8Array) return value;
    if (typeof value === "object") {
      const shape = value as { labels?: string[]; properties?: Record<string, unknown>; elementId?: string; type?: string; startNodeElementId?: string; endNodeElementId?: string };
      if (shape.properties && shape.elementId) {
        return { [ID_COLUMN]: shape.elementId, ...(shape.labels ? { labels: shape.labels } : {}), ...(shape.type ? { type: shape.type, start: shape.startNodeElementId, end: shape.endNodeElementId } : {}), ...(this.plain(shape.properties, neo4j) as object) };
      }
      if (value.constructor !== Object) return String(value);
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.plain(item, neo4j)]));
    }
    return value;
  }

  async ping() {
    return this.withSession(undefined, "READ", async (session) => {
      const result = await session.run("CALL dbms.components() YIELD name, versions RETURN name, versions[0] AS version");
      const record = result.records[0];
      return { serverVersion: `${String(record?.get("name") ?? "Neo4j")} ${String(record?.get("version") ?? "")}`.trim() };
    });
  }

  async listDatabases() {
    return this.withSession("system", "READ", async (session) => {
      const result = await session.run("SHOW DATABASES YIELD name, currentStatus WHERE currentStatus = 'online' RETURN DISTINCT name");
      return result.records.map((record) => String(record.get("name"))).filter((name) => name !== "system");
    });
  }

  async listSchemas() {
    return [];
  }

  async listObjects(scope: Scope, options: { pattern: string; cursor: string | null }): Promise<ObjectPage> {
    return this.withSession(scope.database, "READ", async (session) => {
      const result = await session.run("CALL db.labels() YIELD label RETURN label ORDER BY label");
      const needle = options.pattern.toLowerCase();
      return { objects: result.records.map((record) => String(record.get("label"))).filter((name) => !needle || name.toLowerCase().includes(needle)).map((name) => ({ name, kind: "label" })), nextCursor: null };
    });
  }

  private columnsOf(rows: { [key: string]: unknown }[]): string[] {
    const names = new Map<string, null>([[ID_COLUMN, null]]);
    for (const row of rows) for (const name of Object.keys(row)) names.set(name, null);
    return [...names.keys()];
  }

  async describe(ref: ObjectRef): Promise<ObjectDetails> {
    return this.withSession(ref.database, "READ", async (session, neo4j) => {
      const sample = await session.run(`MATCH (n:${quoteLabel(ref.name)}) RETURN n LIMIT 50`);
      const rows = sample.records.map((record) => this.plain((record.get("n") as { properties: object }).properties, neo4j) as Record<string, unknown>);
      const count = await session.run(`MATCH (n:${quoteLabel(ref.name)}) RETURN count(n) AS c`);
      const indexes = await session.run("SHOW INDEXES YIELD name, labelsOrTypes, properties, owningConstraint WHERE $label IN labelsOrTypes RETURN name, properties, owningConstraint", { label: ref.name });
      return {
        name: ref.name,
        kind: "label",
        columns: this.columnsOf(rows).map((name) => ({ name, type: null, nullable: true, defaultValue: null, isKey: name === ID_COLUMN, generated: name === ID_COLUMN })),
        keyColumns: [ID_COLUMN],
        keyReason: null,
        indexes: indexes.records.map((record) => ({ name: String(record.get("name")), columns: (record.get("properties") as string[]) ?? [], unique: record.get("owningConstraint") !== null })),
        foreignKeys: [],
        definition: null,
        facts: [{ label: "Nodes", value: String(this.plain(count.records[0]?.get("c"), neo4j)) }],
      };
    });
  }

  private where(filters: Filter[]): { sql: string; params: Record<string, unknown> } {
    const parts: string[] = [];
    const params: Record<string, unknown> = {};
    for (const [index, item] of filters.entries()) {
      const name = `f${index}`;
      const property = item.column === ID_COLUMN ? "elementId(n)" : `n.${quoteLabel(item.column)}`;
      const number = item.value !== "" && !Number.isNaN(Number(item.value)) ? Number(item.value) : null;
      params[name] = item.value;
      switch (item.op) {
        case "null":
          parts.push(`${property} IS NULL`);
          break;
        case "notnull":
          parts.push(`${property} IS NOT NULL`);
          break;
        case "contains":
          parts.push(`toLower(toString(${property})) CONTAINS toLower($${name})`);
          break;
        case "starts":
          parts.push(`toString(${property}) STARTS WITH $${name}`);
          break;
        default: {
          const operator = { eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[item.op];
          // A property may hold a number or text, and Cypher does not compare across types.
          if (number !== null && item.column !== ID_COLUMN) {
            params[`${name}n`] = number;
            parts.push(`(${property} ${operator} $${name} OR ${property} ${operator} $${name}n)`);
          } else parts.push(`${property} ${operator} $${name}`);
        }
      }
    }
    return { sql: parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "", params };
  }

  private order(sort: Sort | null): string {
    if (!sort) return " ORDER BY elementId(n)";
    return ` ORDER BY ${sort.column === ID_COLUMN ? "elementId(n)" : `n.${quoteLabel(sort.column)}`} ${sort.descending ? "DESC" : "ASC"}`;
  }

  private rowsOf(records: { get(name: string): unknown }[], neo4j: Neo4j) {
    const flat = records.map((record) => {
      const node = record.get("n") as { elementId: string; properties: object };
      return { [ID_COLUMN]: node.elementId, ...(this.plain(node.properties, neo4j) as object) } as Record<string, unknown>;
    });
    const names = this.columnsOf(flat);
    return { names, rows: flat.map((row) => names.map((name) => row[name] ?? null)) };
  }

  async read(ref: ObjectRef, query: ReadQuery): Promise<RowPage> {
    const skip = query.cursor === null ? 0 : Number(query.cursor);
    if (!Number.isSafeInteger(skip) || skip < 0) throw new Error("Invalid page position.");
    return this.withSession(ref.database, "READ", async (session, neo4j) => {
      const where = this.where(query.filters);
      const result = await session.run(`MATCH (n:${quoteLabel(ref.name)})${where.sql} RETURN n${this.order(query.sort)} SKIP $skip LIMIT $limit`, { ...where.params, skip: neo4j.int(skip), limit: neo4j.int(query.limit + 1) });
      const { names, rows } = this.rowsOf(result.records.slice(0, query.limit), neo4j);
      const finished = finishRows(rows);
      return {
        columns: names.map((name) => ({ name, type: null, nullable: true, defaultValue: null, isKey: name === ID_COLUMN, generated: name === ID_COLUMN })),
        keyColumns: [ID_COLUMN],
        keyReason: null,
        rows: finished.rows,
        cutCells: finished.cutCells,
        truncated: finished.rows.length < rows.length,
        nextCursor: result.records.length > query.limit || finished.rows.length < rows.length ? String(skip + finished.rows.length) : null,
      };
    });
  }

  async count(ref: ObjectRef, filters: Filter[]): Promise<number> {
    return this.withSession(ref.database, "READ", async (session, neo4j) => {
      const where = this.where(filters);
      const result = await session.run(`MATCH (n:${quoteLabel(ref.name)})${where.sql} RETURN count(n) AS c`, where.params);
      return Number(this.plain(result.records[0]?.get("c"), neo4j));
    });
  }

  async readRow(ref: ObjectRef, key: RowKey): Promise<RowPage> {
    return this.withSession(ref.database, "READ", async (session, neo4j) => {
      const result = await session.run(`MATCH (n:${quoteLabel(ref.name)}) WHERE elementId(n) = $id RETURN n`, { id: String(key[ID_COLUMN]) });
      const { names, rows } = this.rowsOf(result.records, neo4j);
      const finished = finishRows(rows, null, Number.MAX_SAFE_INTEGER);
      return { columns: names.map((name) => ({ name, type: null, nullable: true, defaultValue: null, isKey: name === ID_COLUMN, generated: name === ID_COLUMN })), keyColumns: [ID_COLUMN], keyReason: null, rows: finished.rows, cutCells: [], truncated: false, nextCursor: null };
    });
  }

  async planWrite(ref: ObjectRef, op: WriteOp): Promise<WritePlan> {
    const label = quoteLabel(ref.name);
    if (op.kind === "insert") {
      const { [ID_COLUMN]: _ignored, ...properties } = op.values;
      return {
        preview: `CREATE (n:${label} ${JSON.stringify(properties)})`,
        run: () => this.withSession(ref.database, "WRITE", async (session, neo4j) => (await session.executeWrite((tx) => tx.run(`CREATE (n:${label}) SET n = $properties`, { properties: integersFor(properties, neo4j) }))).summary.counters.updates().nodesCreated),
      };
    }
    if (op.kind === "update") {
      if (ID_COLUMN in op.changes) throw new Error("A node's element ID cannot be changed.");
      const id = String(op.key[ID_COLUMN] ?? "");
      if (!id) throw new Error("A node is identified by its element ID.");
      return {
        preview: `MATCH (n:${label}) WHERE elementId(n) = ${renderLiteral(id)} SET n += ${JSON.stringify(op.changes)}`,
        run: () =>
          this.withSession(ref.database, "WRITE", async (session, neo4j) => {
            const result = await session.executeWrite((tx) => tx.run(`MATCH (n:${label}) WHERE elementId(n) = $id SET n += $changes RETURN elementId(n) AS id`, { id, changes: integersFor(op.changes, neo4j) }));
            if (result.records.length !== 1) throw new Error("No node matched its ID. Someone may have deleted it; refresh and try again.");
            return 1;
          }),
      };
    }
    const ids = op.keys.map((key) => String(key[ID_COLUMN] ?? ""));
    if (ids.some((id) => id === "")) throw new Error("A node is identified by its element ID.");
    return {
      preview: `MATCH (n:${label}) WHERE elementId(n) IN ${JSON.stringify(ids.slice(0, 20))}${ids.length > 20 ? ` ...and ${ids.length - 20} more` : ""} DETACH DELETE n`,
      run: () => this.withSession(ref.database, "WRITE", async (session) => (await session.executeWrite((tx) => tx.run(`MATCH (n:${label}) WHERE elementId(n) IN $ids DETACH DELETE n`, { ids }))).summary.counters.updates().nodesDeleted),
    };
  }

  async planDestroy(ref: ObjectRef, action: "drop" | "truncate"): Promise<WritePlan> {
    if (action === "truncate") throw new Error("Use drop: Neo4j removes a label by deleting its nodes.");
    const cypher = `MATCH (n:${quoteLabel(ref.name)}) CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF 1000 ROWS`;
    return {
      preview: cypher,
      run: () =>
        this.withSession(ref.database, "WRITE", async (session) => {
          await session.run(cypher);
          return 0;
        }),
    };
  }

  async parse(text: string): Promise<ParsedStatement[]> {
    // Only the splitting is shared with CQL; Cypher has its own rules for what reads.
    return splitStatements(text, "cassandra").map((statement) => ({ text: statement.text, class: classifyCypher(statement.text) }));
  }

  async run(statements: ParsedStatement[], context: RunContext): Promise<QueryResult[]> {
    const results: QueryResult[] = [];
    const blank = { type: null, nullable: null, defaultValue: null, isKey: false, generated: false };
    for (const statement of statements) {
      if (context.signal.aborted) throw new PartialRunError("Cancelled.", results);
      const started = Date.now();
      try {
        // Each statement has its own session, so nothing carries over.
        const result = await this.withSession(context.scope.database, context.readOnly ? "READ" : "WRITE", async (session, neo4j) => {
          const closeOnAbort = () => void session.close().catch(() => undefined);
          context.signal.addEventListener("abort", closeOnAbort, { once: true });
          try {
            const outcome = context.readOnly ? await session.executeRead((tx) => tx.run(statement.text)) : await session.run(statement.text);
            const names = outcome.records[0]?.keys.map(String) ?? [];
            const finished = finishRows(outcome.records.map((record) => names.map((name) => this.plain(record.get(name), neo4j))), context.limit);
            const counters = outcome.summary.counters.updates();
            const changed = counters.nodesCreated + counters.nodesDeleted + counters.relationshipsCreated + counters.relationshipsDeleted + counters.propertiesSet;
            return { names, finished, changed };
          } finally {
            context.signal.removeEventListener("abort", closeOnAbort);
          }
        });
        results.push({ statement: statement.text, columns: result.names.map((name) => ({ ...blank, name })), rows: result.finished.rows, cutCells: result.finished.cutCells, truncated: result.finished.truncated, affected: result.names.length === 0 ? result.changed : null, durationMs: Date.now() - started, message: null });
      } catch (error) {
        throw new PartialRunError(errorMessage(error), results);
      }
    }
    return results;
  }

  async stream(source: StreamSource, signal: AbortSignal, onBatch: (batch: StreamBatch) => Promise<boolean>): Promise<void> {
    const blank = { type: null, nullable: null, defaultValue: null, isKey: false, generated: false };
    if (source.kind === "object") {
      const seen = new Map<string, null>();
      let skip = 0;
      for (;;) {
        if (signal.aborted) throw new Error("Cancelled.");
        const done = await this.withSession(source.ref.database, "READ", async (session, neo4j) => {
          const where = this.where(source.filters);
          const result = await session.run(`MATCH (n:${quoteLabel(source.ref.name)})${where.sql} RETURN n${this.order(source.sort)} SKIP $skip LIMIT $limit`, { ...where.params, skip: neo4j.int(skip), limit: neo4j.int(STREAM_BATCH) });
          if (result.records.length === 0) return true;
          const { names, rows } = this.rowsOf(result.records, neo4j);
          for (const name of names) seen.set(name, null);
          const all = [...seen.keys()];
          const aligned = rows.map((row) => all.map((name) => row[names.indexOf(name)] ?? null));
          if (!(await onBatch({ columns: all.map((name) => ({ ...blank, name })), rows: aligned }))) return true;
          skip += result.records.length;
          return result.records.length < STREAM_BATCH;
        });
        if (done) return;
      }
    }
    const statements = await this.parse(source.text);
    if (statements.length !== 1 || statements[0]?.class !== "read") throw new Error("Export runs one read statement.");
    const text = statements[0].text;
    await this.withSession(source.scope.database, "READ", async (session, neo4j) => {
      const outcome = await session.executeRead((tx) => tx.run(text));
      const names = outcome.records[0]?.keys.map(String) ?? [];
      await onBatch({ columns: names.map((name) => ({ ...blank, name })), rows: outcome.records.map((record) => names.map((name) => this.plain(record.get(name), neo4j))) });
    });
  }

  async importInto(ref: ObjectRef, columns: string[], produce: (insert: (rows: unknown[][]) => Promise<void>) => Promise<void>): Promise<void> {
    const label = quoteLabel(ref.name);
    await this.withSession(ref.database, "WRITE", async (session, neo4j) => {
      const transaction = session.beginTransaction();
      try {
        await produce(async (rows) => {
          const documents = rows.map((row) => Object.fromEntries(columns.flatMap((name, index) => (row[index] === undefined || row[index] === null ? [] : [[name, row[index]]]))));
          await transaction.run(`UNWIND $documents AS document CREATE (n:${label}) SET n = document`, { documents: integersFor(documents, neo4j) });
        });
        await transaction.commit();
      } catch (error) {
        await transaction.rollback().catch(() => undefined);
        throw error;
      }
    });
  }

  async close() {
    const current = this.driverPromise;
    this.driverPromise = null;
    if (current) await (await current).driver.close();
  }
}

export async function createNeo4j(context: AdapterContext): Promise<Adapter> {
  return new Neo4jAdapter(context);
}
