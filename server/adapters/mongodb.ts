import type { Db, Document, MongoClient, MongoClientOptions } from "mongodb";
import { z } from "zod";
import { loadDriver } from "../drivers";
import type { ColumnInfo, Filter, ObjectDetails, ObjectPage, ObjectRef, QueryResult, ReadQuery, RowKey, RowPage, Scope, Sort, WriteOp } from "../../shared/contracts";
import { finishRows, positionsOf } from "../cells";
import { errorMessage } from "../errors";
import { tlsClientOptions } from "../tls";
import { PartialRunError, STREAM_BATCH } from "./sql-base";
import type { Adapter, AdapterContext, ParsedStatement, RunContext, StreamBatch, StreamSource, WritePlan } from "./types";

// Query box methods. Anything not listed is refused, on every safety mode, so the box can never run
// an arbitrary method. Reads run on read-only connections; writes do not.
const READ_METHODS = new Set(["find", "findOne", "aggregate", "countDocuments", "estimatedDocumentCount", "distinct", "getIndexes"]);
const WRITE_METHODS = new Set(["insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany", "createIndex", "dropIndex", "drop", "bulkWrite", "findOneAndUpdate", "findOneAndReplace", "findOneAndDelete"]);
const DB_READ_METHODS = new Set(["getCollectionNames", "listCollections", "stats", "version"]);
const DB_WRITE_METHODS = new Set(["createCollection", "dropDatabase", "runCommand"]);
function withoutRejectFlag({ rejectUnauthorized: _ignored, ...rest }: ReturnType<typeof tlsClientOptions>) {
  return rest;
}

const CURSOR_MODIFIERS = new Set(["limit", "skip", "sort", "project", "projection", "toArray", "maxTimeMS", "hint", "collation"]);
// These aggregation stages write. A pipeline with one anywhere, at any depth, is a write.
const WRITING_STAGES = new Set(["$out", "$merge"]);

interface ParsedCall {
  text: string;
  collection: string | null;
  method: string;
  args: unknown[];
  modifiers: { name: string; args: unknown[] }[];
}

function hasWritingStage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasWritingStage);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, item]) => WRITING_STAGES.has(key) || hasWritingStage(item));
  }
  return false;
}

// Splits `a(...).b(...)` on top-level dots and finds each call's argument text, respecting strings and
// brackets. The arguments are parsed by MongoDB's own parser, which reads an AST and never evaluates.
function splitChain(source: string): { name: string; argsText: string }[] {
  const links: { name: string; argsText: string }[] = [];
  let index = 0;
  while (index < source.length) {
    const name = /^[\s.]*([A-Za-z_$][\w$]*)/.exec(source.slice(index));
    if (!name?.[1]) throw new Error(`Could not read this query near: ${source.slice(index, index + 60)}`);
    index += name[0].length;
    while (/\s/.test(source[index] ?? "")) index += 1;
    if (source[index] !== "(") {
      links.push({ name: name[1], argsText: "\0none" });
      continue;
    }
    let depth = 0;
    let quote: string | null = null;
    const start = index + 1;
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "(" || char === "[" || char === "{") depth += 1;
      else if (char === ")" || char === "]" || char === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) throw new Error("A bracket in this query is not closed.");
    links.push({ name: name[1], argsText: source.slice(start, index) });
    index += 1;
  }
  return links;
}

export function splitMongoScript(text: string): string[] {
  const statements: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quote) {
      current += char;
      if (char === "\\") {
        index += 1;
        current += text[index] ?? "";
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    if (char === "(" || char === "[" || char === "{") depth += 1;
    if (char === ")" || char === "]" || char === "}") depth -= 1;
    // A new statement starts at a line beginning "db." with every bracket closed, or after a semicolon.
    if (depth === 0 && (char === ";" || (char === "\n" && /^\s*db\./.test(text.slice(index + 1))))) {
      if (current.trim()) statements.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

async function parseArgs(argsText: string): Promise<unknown[]> {
  if (argsText === "\0none" || argsText.trim() === "") return [];
  const { default: parse } = await loadDriver<{ default: (text: string, options: unknown) => unknown }>("@mongodb-js/shell-bson-parser");
  const parsed: unknown = await parse(`[${argsText}]`, { mode: "strict" });
  return z.array(z.unknown()).parse(parsed);
}

export function classifyMongoStatement(text: string): ParsedStatement {
  try {
    const links = splitChain(text);
    if (links[0]?.name !== "db") return { text, class: "unknown" };
    const second = links[1];
    if (!second) return { text, class: "unknown" };
    if (second.argsText !== "\0none") {
      return { text, class: DB_READ_METHODS.has(second.name) ? "read" : "write" };
    }
    const method = links[2]?.name;
    if (!method) return { text, class: "unknown" };
    if (!READ_METHODS.has(method)) return { text, class: "write" };
    // $out and $merge can sit in nested $lookup and $facet pipelines, so check the raw text too: a
    // false match costs a prompt.
    if (method === "aggregate" && /\$(out|merge)\b/.test(links[2]?.argsText ?? "")) return { text, class: "write" };
    return { text, class: "read" };
  } catch {
    return { text, class: "unknown" };
  }
}

async function parseCall(text: string): Promise<ParsedCall> {
  const links = splitChain(text);
  if (links[0]?.name !== "db" || links[0].argsText !== "\0none") throw new Error('Start with db, like db.users.find({}) or db.getCollection("users").find({}).');
  let position = 1;
  let collection: string | null = null;
  if (links[1]?.name === "getCollection") {
    const [name] = await parseArgs(links[1].argsText);
    if (typeof name !== "string") throw new Error("getCollection takes a collection name.");
    collection = name;
    position = 2;
  } else if (links[1]?.argsText === "\0none") {
    collection = links[1].name;
    position = 2;
  }
  const call = links[position];
  if (!call) throw new Error("Name a method, like db.users.find({}).");
  const allowed = collection === null ? DB_READ_METHODS.has(call.name) || DB_WRITE_METHODS.has(call.name) : READ_METHODS.has(call.name) || WRITE_METHODS.has(call.name);
  if (!allowed) throw new Error(`${call.name} is not available here.`);
  const modifiers: { name: string; args: unknown[] }[] = [];
  for (const link of links.slice(position + 1)) {
    if (!CURSOR_MODIFIERS.has(link.name)) throw new Error(`.${link.name}() is not available here.`);
    modifiers.push({ name: link.name, args: await parseArgs(link.argsText) });
  }
  return { text, collection, method: call.name, args: await parseArgs(call.argsText), modifiers };
}

async function extendedJson() {
  const { BSON, Long } = await loadDriver<typeof import("mongodb")>("mongodb");
  const { EJSON } = BSON;
  // EJSON's relaxed form turns every Long into a number and rounds it, so unsafe ones stay canonical.
  const keepLongs = (value: unknown): unknown => {
    if (value instanceof Long) return value.greaterThan(Number.MAX_SAFE_INTEGER) || value.lessThan(Number.MIN_SAFE_INTEGER) ? { $numberLong: value.toString() } : value.toNumber();
    if (Array.isArray(value)) return value.map(keepLongs);
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, keepLongs(item)]));
    return value;
  };
  return { EJSON: { parse: EJSON.parse, deserialize: EJSON.deserialize, serialize: (value: Document, options: { relaxed: boolean }) => EJSON.serialize(keepLongs(value), options) } };
}

class MongoAdapter implements Adapter {
  private clientPromise: Promise<MongoClient> | null = null;
  private readonly context: AdapterContext;

  constructor(context: AdapterContext) {
    this.context = context;
  }

  private client(): Promise<MongoClient> {
    this.clientPromise ??= (async () => {
      const { connection, endpoint } = this.context;
      if (!endpoint) throw new Error("MongoDB needs a host.");
      const { MongoClient: Client } = await loadDriver<typeof import("mongodb")>("mongodb");
      const options: MongoClientOptions = {
        serverSelectionTimeoutMS: 15000,
        connectTimeoutMS: 15000,
        maxPoolSize: 5,
        // Stays on this host. Following a replica set's advertised addresses would leave an SSH tunnel.
        directConnection: true,
        promoteLongs: false,
        appName: "datawise",
        auth: connection.user ? { username: connection.user, password: connection.password ?? undefined } : undefined,
        authSource: connection.authSource || undefined,
        tls: connection.tls !== "off",
        tlsAllowInvalidCertificates: connection.tls === "require",
        tlsAllowInvalidHostnames: connection.tls === "require",
        // The same check as every other engine, so a tunnel's address is never what the certificate must name.
        // rejectUnauthorized stays out: the driver sets it from tlsAllowInvalidCertificates above.
        ...(connection.tls === "off" ? {} : withoutRejectFlag(tlsClientOptions(connection, endpoint))),
      } as MongoClientOptions;
      const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
      const client = new Client(`mongodb://${host}:${endpoint.port}/`, options);
      await client.connect();
      client.on("error", () => this.context.onLost());
      return client;
    })();
    this.clientPromise.catch(() => {
      this.clientPromise = null;
    });
    return this.clientPromise;
  }

  private async db(scope: Scope): Promise<Db> {
    const name = scope.database || this.context.connection.database;
    if (!name) throw new Error("Pick a database first.");
    return (await this.client()).db(name);
  }

  async ping() {
    const client = await this.client();
    const info = await client.db("admin").command({ buildInfo: 1 });
    return { serverVersion: `MongoDB ${String(info.version)}` };
  }

  async listDatabases() {
    const client = await this.client();
    try {
      const { databases } = await client.db("admin").admin().listDatabases({ nameOnly: true });
      return databases.map((item) => item.name);
    } catch (error) {
      // A user limited to one database may not list them all. That database still works.
      if (this.context.connection.database) return [this.context.connection.database];
      throw error;
    }
  }

  async listSchemas() {
    return [];
  }

  async listObjects(scope: Scope, options: { pattern: string; cursor: string | null }): Promise<ObjectPage> {
    const db = await this.db(scope);
    const list = await db.listCollections({}, { nameOnly: false }).toArray();
    const needle = options.pattern.toLowerCase();
    return {
      objects: list
        .filter((item) => !needle || item.name.toLowerCase().includes(needle))
        .map((item) => ({ name: item.name, kind: item.type === "view" ? "view" : "collection" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      nextCursor: null,
    };
  }

  async describe(ref: ObjectRef): Promise<ObjectDetails> {
    const db = await this.db(ref);
    const info = (await db.listCollections({ name: ref.name }).toArray())[0];
    if (!info) throw new Error(`${ref.name} was not found.`);
    const collection = db.collection(ref.name);
    const isView = info.type === "view";
    const sample = await collection.find({}).limit(50).toArray();
    const indexes = isView ? [] : await collection.indexes();
    const count = await collection.estimatedDocumentCount().catch(() => null);
    const columns = fieldsOf(sample);
    return {
      name: ref.name,
      kind: isView ? "view" : "collection",
      columns: columns.map((name) => ({ name, type: null, nullable: true, defaultValue: null, isKey: name === "_id", generated: name === "_id" })),
      keyColumns: isView ? [] : ["_id"],
      keyReason: isView ? "A view cannot be edited here." : null,
      indexes: indexes.map((index) => ({ name: String(index.name), columns: Object.keys(index.key), unique: Boolean(index.unique) || index.name === "_id_" })),
      foreignKeys: [],
      definition: isView ? JSON.stringify((info as { options?: unknown }).options ?? {}, null, 2) : null,
      facts: [{ label: "Estimated documents", value: count === null ? "unknown" : String(count) }],
    };
  }

  private async compileFilters(filters: Filter[]): Promise<Document> {
    const { EJSON } = await extendedJson();
    const clauses: Document[] = [];
    for (const item of filters) {
      const operand = () => {
        // A filter value can be plain text, or a typed value such as {"$oid":"..."} or 5.
        try {
          return EJSON.parse(item.value);
        } catch {
          return item.value;
        }
      };
      const regexText = item.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const clause: Record<Filter["op"], () => Document> = {
        eq: () => ({ $eq: operand() }),
        ne: () => ({ $ne: operand() }),
        gt: () => ({ $gt: operand() }),
        gte: () => ({ $gte: operand() }),
        lt: () => ({ $lt: operand() }),
        lte: () => ({ $lte: operand() }),
        contains: () => ({ $regex: regexText, $options: "i" }),
        starts: () => ({ $regex: `^${regexText}` }),
        null: () => ({ $eq: null }),
        notnull: () => ({ $ne: null }),
      };
      clauses.push({ [item.column]: clause[item.op]() });
    }
    return clauses.length > 0 ? { $and: clauses } : {};
  }

  private toSort(sort: Sort | null): Record<string, 1 | -1> | undefined {
    return sort ? { [sort.column]: sort.descending ? -1 : 1 } : undefined;
  }

  private async pageFromDocs(documents: Document[], limit: number | null, offset: number, fetched: number, cellLimit: number, bytesAsSize: boolean): Promise<RowPage> {
    const { EJSON } = await extendedJson();
    const relaxed = documents.map((document) => EJSON.serialize(document, { relaxed: true }) as Document);
    const names = fieldsOf(relaxed);
    const finished = finishRows(relaxed.map((document) => names.map((name) => document[name] ?? null)), limit, cellLimit, bytesAsSize, positionsOf(names, ["_id"]));
    return {
      columns: names.map((name): ColumnInfo => ({ name, type: null, nullable: true, defaultValue: null, isKey: name === "_id", generated: name === "_id" })),
      keyColumns: ["_id"],
      keyReason: null,
      rows: finished.rows,
      cutCells: finished.cutCells,
      truncated: finished.rows.length < Math.min(documents.length, limit ?? documents.length),
      // After a cut for size, the next page starts at the first row left out, so nothing is skipped.
      nextCursor: limit !== null && (fetched > limit || finished.rows.length < Math.min(documents.length, limit)) ? String(offset + finished.rows.length) : null,
    };
  }

  // An agent's read. Datawise builds this query itself, so no agent-written text reaches the database.
  readIsolated(ref: ObjectRef, query: ReadQuery, cellLimit: number): Promise<RowPage> {
    return this.read(ref, query, cellLimit, true);
  }

  async read(ref: ObjectRef, query: ReadQuery, cellLimit: number, bytesAsSize = false): Promise<RowPage> {
    const db = await this.db(ref);
    const offset = query.cursor === null ? 0 : Number(query.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid page position.");
    const documents = await db.collection(ref.name).find(await this.compileFilters(query.filters), { sort: this.toSort(query.sort) }).skip(offset).limit(query.limit + 1).toArray();
    const page = await this.pageFromDocs(documents, query.limit, offset, documents.length, cellLimit, bytesAsSize);
    const details = await db.listCollections({ name: ref.name }).toArray();
    if (details[0]?.type === "view") return { ...page, keyColumns: [], keyReason: "A view cannot be edited here." };
    return page;
  }

  async count(ref: ObjectRef, filters: Filter[], timeoutMs: number): Promise<number> {
    return (await this.db(ref)).collection(ref.name).countDocuments(await this.compileFilters(filters), { maxTimeMS: timeoutMs });
  }

  private async keyFilter(key: RowKey): Promise<Document> {
    if (!("_id" in key) || key._id === null || key._id === undefined) throw new Error("A document is identified by its _id.");
    const { EJSON } = await extendedJson();
    return { _id: EJSON.deserialize({ value: key._id }, { relaxed: true }).value };
  }

  async readRow(ref: ObjectRef, key: RowKey): Promise<RowPage> {
    const document = await (await this.db(ref)).collection(ref.name).findOne(await this.keyFilter(key));
    const { EJSON } = await extendedJson();
    if (!document) return { columns: [], keyColumns: ["_id"], keyReason: null, rows: [], cutCells: [], truncated: false, nextCursor: null };
    const relaxed = EJSON.serialize(document, { relaxed: true }) as Document;
    const names = Object.keys(relaxed);
    const finished = finishRows([names.map((name) => relaxed[name])], null, Number.MAX_SAFE_INTEGER);
    return { columns: names.map((name) => ({ name, type: null, nullable: true, defaultValue: null, isKey: name === "_id", generated: name === "_id" })), keyColumns: ["_id"], keyReason: null, rows: finished.rows, cutCells: [], truncated: false, nextCursor: null };
  }

  async planWrite(ref: ObjectRef, op: WriteOp): Promise<WritePlan> {
    const { EJSON } = await extendedJson();
    const db = await this.db(ref);
    const collection = db.collection(ref.name);
    const decode = (value: Record<string, unknown>) => EJSON.deserialize(value, { relaxed: true }) as Document;
    if (op.kind === "insert") {
      const document = decode(op.values);
      return { preview: `db.${ref.name}.insertOne(${JSON.stringify(op.values)})`, run: async () => ((await collection.insertOne(document)).acknowledged ? 1 : 0) };
    }
    if (op.kind === "update") {
      if ("_id" in op.changes) throw new Error("A document's _id cannot be changed.");
      const filter = await this.keyFilter(op.key);
      const changes = decode(op.changes);
      const set: Document = {};
      const unset: Document = {};
      for (const [name, value] of Object.entries(changes)) {
        if (value === undefined) unset[name] = "";
        else set[name] = value;
      }
      const update: Document = {};
      if (Object.keys(set).length > 0) update.$set = set;
      if (Object.keys(unset).length > 0) update.$unset = unset;
      return {
        preview: `db.${ref.name}.updateOne(${JSON.stringify({ _id: op.key._id })}, ${JSON.stringify({ $set: op.changes })})`,
        run: async () => {
          const result = await collection.updateOne(filter, update);
          if (result.matchedCount !== 1) throw new Error("No document matched its _id. Someone may have changed or deleted it; refresh and try again.");
          return result.modifiedCount;
        },
      };
    }
    const filters = await Promise.all(op.keys.map((key) => this.keyFilter(key)));
    return {
      preview: `db.${ref.name}.deleteMany({ _id: { $in: ${JSON.stringify(op.keys.slice(0, 20).map((key) => key._id))}${op.keys.length > 20 ? ` ...and ${op.keys.length - 20} more` : ""} } })`,
      run: async () => (await collection.deleteMany({ _id: { $in: filters.map((filter) => filter._id) } })).deletedCount,
    };
  }

  async planDestroy(ref: ObjectRef, action: "drop" | "truncate"): Promise<WritePlan> {
    const collection = (await this.db(ref)).collection(ref.name);
    if (action === "drop") return { preview: `db.${ref.name}.drop()`, run: async () => ((await collection.drop()) ? 0 : 0) };
    return { preview: `db.${ref.name}.deleteMany({})`, run: async () => (await collection.deleteMany({})).deletedCount };
  }

  async parse(text: string): Promise<ParsedStatement[]> {
    return Promise.all(
      splitMongoScript(text).map(async (statement) => {
        const parsed = classifyMongoStatement(statement);
        if (parsed.class !== "read" || !/\baggregate\b/.test(statement)) return parsed;
        // The text check above can miss an escaped name. The parser's output cannot hide one.
        try {
          const call = await parseCall(statement);
          return hasWritingStage(call.args) ? { text: statement, class: "write" as const } : parsed;
        } catch {
          return { text: statement, class: "unknown" as const };
        }
      }),
    );
  }

  private async execute(call: ParsedCall, context: RunContext): Promise<{ documents: Document[] | null; affected: number | null; message: string | null; truncated: boolean }> {
    const db = await this.db(context.scope);
    const maxTimeMS = context.timeoutMs;
    const single = (value: unknown) => ({ documents: value === null || value === undefined ? [] : [(typeof value === "object" && !Array.isArray(value) ? value : { value }) as Document], affected: null, message: null, truncated: false });
    if (call.collection === null) {
      const [first, second] = call.args;
      switch (call.method) {
        case "getCollectionNames":
          return { ...single(null), documents: (await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => ({ name: item.name })) };
        case "listCollections":
          return { ...single(null), documents: await db.listCollections((first ?? {}) as Document, (second ?? {}) as never).toArray() };
        case "stats":
          return single(await db.stats());
        case "version":
          return single({ version: (await db.admin().serverInfo()).version });
        case "createCollection":
          await db.createCollection(String(first), (second ?? {}) as never);
          return { documents: null, affected: null, message: `Created ${String(first)}.`, truncated: false };
        case "dropDatabase":
          await db.dropDatabase();
          return { documents: null, affected: null, message: `Dropped ${db.databaseName}.`, truncated: false };
        default:
          return single(await db.command((first ?? {}) as Document, { signal: context.signal } as never));
      }
    }
    const collection = db.collection(call.collection);
    const [first, second, third] = call.args as [Document | undefined, Document | undefined, Document | undefined];
    const options = { signal: context.signal, maxTimeMS } as never;
    switch (call.method) {
      case "find":
      case "aggregate": {
        if (call.method === "aggregate" && context.readOnly && hasWritingStage(first)) throw new Error("This connection is read-only, and $out and $merge write data.");
        let cursor = call.method === "find" ? collection.find(first ?? {}, { ...(second ? { projection: second } : {}), signal: context.signal, maxTimeMS } as never) : collection.aggregate((first ?? []) as unknown as Document[], { ...(second ?? {}), signal: context.signal, maxTimeMS } as never);
        for (const modifier of call.modifiers) {
          const argument = modifier.args[0];
          if (modifier.name === "toArray") continue;
          const target = cursor as unknown as Record<string, (value: unknown) => typeof cursor>;
          const name = modifier.name === "projection" ? "project" : modifier.name;
          if (typeof target[name] !== "function") throw new Error(`.${modifier.name}() does not apply to ${call.method}.`);
          cursor = target[name].call(cursor, argument);
        }
        const documents: Document[] = [];
        let truncated = false;
        for await (const document of cursor) {
          if (documents.length >= context.limit) {
            truncated = true;
            break;
          }
          documents.push(document);
        }
        await cursor.close();
        return { documents, affected: null, message: null, truncated };
      }
      case "findOne":
        return single(await collection.findOne(first ?? {}, options));
      case "countDocuments":
        return single({ count: await collection.countDocuments(first ?? {}, options) });
      case "estimatedDocumentCount":
        return single({ count: await collection.estimatedDocumentCount(options) });
      case "distinct":
        return { ...single(null), documents: (await collection.distinct(String(first), (second ?? {}) as never, options)).slice(0, context.limit).map((value) => ({ value })) };
      case "getIndexes":
        return { ...single(null), documents: (await collection.indexes()) as Document[] };
      case "insertOne":
        return { documents: null, affected: (await collection.insertOne(first ?? {}, options)).acknowledged ? 1 : 0, message: null, truncated: false };
      case "insertMany":
        return { documents: null, affected: (await collection.insertMany((first ?? []) as unknown as Document[], options)).insertedCount, message: null, truncated: false };
      case "updateOne":
      case "updateMany":
      case "replaceOne": {
        const result = await (call.method === "updateOne" ? collection.updateOne(first ?? {}, second ?? {}, (third ?? {}) as never) : call.method === "updateMany" ? collection.updateMany(first ?? {}, second ?? {}, (third ?? {}) as never) : collection.replaceOne(first ?? {}, second ?? {}, (third ?? {}) as never));
        return { documents: null, affected: result.modifiedCount + (result.upsertedCount ?? 0), message: `Matched ${result.matchedCount}.`, truncated: false };
      }
      case "deleteOne":
        return { documents: null, affected: (await collection.deleteOne(first ?? {}, options)).deletedCount, message: null, truncated: false };
      case "deleteMany":
        return { documents: null, affected: (await collection.deleteMany(first ?? {}, options)).deletedCount, message: null, truncated: false };
      case "createIndex":
        return { documents: null, affected: null, message: `Created index ${await collection.createIndex((first ?? {}) as never, (second ?? {}) as never)}.`, truncated: false };
      case "dropIndex":
        await collection.dropIndex(String(first));
        return { documents: null, affected: null, message: `Dropped index ${String(first)}.`, truncated: false };
      case "drop":
        await collection.drop();
        return { documents: null, affected: null, message: `Dropped ${call.collection}.`, truncated: false };
      case "bulkWrite": {
        const result = await collection.bulkWrite((first ?? []) as never, (second ?? {}) as never);
        return { documents: null, affected: result.insertedCount + result.modifiedCount + result.deletedCount + result.upsertedCount, message: null, truncated: false };
      }
      case "findOneAndUpdate":
        return single(await collection.findOneAndUpdate(first ?? {}, second ?? {}, (third ?? {}) as never));
      case "findOneAndReplace":
        return single(await collection.findOneAndReplace(first ?? {}, second ?? {}, (third ?? {}) as never));
      case "findOneAndDelete":
        return single(await collection.findOneAndDelete(first ?? {}, (second ?? {}) as never));
      default:
        throw new Error(`${call.method} is not available here.`);
    }
  }

  async run(statements: ParsedStatement[], context: RunContext): Promise<QueryResult[]> {
    const { EJSON } = await extendedJson();
    const results: QueryResult[] = [];
    for (const statement of statements) {
      if (context.signal.aborted) throw new PartialRunError("Cancelled.", results);
      const started = Date.now();
      try {
        const call = await parseCall(statement.text);
        const outcome = await this.execute(call, context);
        const relaxed = (outcome.documents ?? []).map((document) => EJSON.serialize(document, { relaxed: true }) as Document);
        const names = fieldsOf(relaxed);
        const finished = finishRows(relaxed.map((document) => names.map((name) => document[name] ?? null)), null, context.cellLimit, context.bytesAsSize);
        results.push({ statement: statement.text, columns: names.map((name) => ({ name, type: null, nullable: null, defaultValue: null, isKey: false, generated: false })), rows: finished.rows, cutCells: finished.cutCells, truncated: outcome.truncated || finished.truncated, affected: outcome.affected, durationMs: Date.now() - started, message: outcome.message });
      } catch (error) {
        throw new PartialRunError(errorMessage(error), results);
      }
    }
    return results;
  }

  async stream(source: StreamSource, signal: AbortSignal, onBatch: (batch: StreamBatch) => Promise<boolean>): Promise<void> {
    const { EJSON } = await extendedJson();
    let cursor: AsyncIterable<Document> & { close(): Promise<void> };
    if (source.kind === "object") {
      cursor = (await this.db(source.ref)).collection(source.ref.name).find(await this.compileFilters(source.filters), { sort: this.toSort(source.sort), signal } as never);
    } else {
      const parsed = await this.parse(source.text);
      const only = parsed[0];
      if (parsed.length !== 1 || !only || only.class !== "read") throw new Error("Export runs one read query.");
      const call = await parseCall(only.text);
      if (call.collection === null || (call.method !== "find" && call.method !== "aggregate")) throw new Error("Export runs find or aggregate.");
      const collection = (await this.db(source.scope)).collection(call.collection);
      if (call.method === "aggregate" && hasWritingStage(call.args[0])) throw new Error("$out and $merge write data. Export runs read queries only.");
      cursor = call.method === "find" ? collection.find((call.args[0] ?? {}) as Document, { signal } as never) : collection.aggregate((call.args[0] ?? []) as Document[], { signal } as never);
    }
    const seen = new Map<string, null>();
    const flush = async (batch: Document[]) => {
      const relaxed = batch.map((document) => EJSON.serialize(document, { relaxed: true }) as Document);
      for (const document of relaxed) for (const name of Object.keys(document)) seen.set(name, null);
      const names = [...seen.keys()];
      return onBatch({ columns: names.map((name) => ({ name, type: null, nullable: null, defaultValue: null, isKey: false, generated: false })), rows: relaxed.map((document) => names.map((name) => document[name] ?? null)) });
    };
    let batch: Document[] = [];
    try {
      for await (const document of cursor) {
        batch.push(document);
        if (batch.length >= STREAM_BATCH) {
          if (!(await flush(batch))) return;
          batch = [];
        }
      }
      if (batch.length > 0) await flush(batch);
    } finally {
      await cursor.close().catch(() => undefined);
    }
  }

  async importInto(ref: ObjectRef, columns: string[], produce: (insert: (rows: unknown[][]) => Promise<void>) => Promise<void>): Promise<void> {
    const collection = (await this.db(ref)).collection(ref.name);
    const { EJSON } = await extendedJson();
    await produce(async (rows) => {
      const documents = rows.map((row) => {
        const document: Record<string, unknown> = {};
        for (const [index, name] of columns.entries()) if (row[index] !== undefined) document[name] = row[index];
        return EJSON.deserialize(document, { relaxed: true }) as Document;
      });
      if (documents.length > 0) await collection.insertMany(documents, { ordered: true });
    });
  }

  async close() {
    const client = this.clientPromise;
    this.clientPromise = null;
    if (client) await (await client).close();
  }
}

function fieldsOf(documents: Document[]): string[] {
  const names = new Map<string, null>();
  for (const document of documents) for (const name of Object.keys(document)) names.set(name, null);
  const list = [...names.keys()];
  return list.includes("_id") ? ["_id", ...list.filter((name) => name !== "_id")] : list;
}

export async function createMongodb(context: AdapterContext): Promise<Adapter> {
  return new MongoAdapter(context);
}
