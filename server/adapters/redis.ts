import { randomUUID } from "node:crypto";
import type { Redis, RedisOptions } from "ioredis";
import { loadDriver } from "../drivers";
import type { ColumnInfo, Filter, ObjectDetails, ObjectPage, ObjectRef, QueryResult, ReadQuery, RowKey, RowPage, Scope, WriteOp } from "../../shared/contracts";
import { finishRows } from "../cells";
import { errorMessage } from "../errors";
import { PartialRunError, STREAM_BATCH } from "./sql-base";
import type { Adapter, AdapterContext, ParsedStatement, RunContext, StreamBatch, StreamSource, WritePlan } from "./types";

// Splits one command line the way redis-cli does: whitespace separates, quotes group, and double
// quotes take backslash escapes.
export function splitCommandLine(line: string): string[] {
  const parts: string[] = [];
  let current = "";
  let started = false;
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (quote) {
      if (char === "\\" && quote === '"') {
        index += 1;
        const next = line[index] ?? "";
        const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"' };
        current += escapes[next] ?? next;
      } else if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) parts.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote) throw new Error("A quote in this command is not closed.");
  if (started) parts.push(current);
  return parts;
}

// Lets the server say what writes. These commands run code or change what the session does, so the
// server's flags are not enough: a script can write however it is declared.
const NEVER_READ = new Set(["EVAL", "EVALSHA", "EVAL_RO", "EVALSHA_RO", "FCALL", "FCALL_RO", "FUNCTION", "SCRIPT", "MODULE", "CONFIG", "ACL", "DEBUG", "SHUTDOWN", "REPLICAOF", "SLAVEOF", "MIGRATE", "MONITOR", "SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "MULTI", "EXEC", "WATCH", "BLPOP", "BRPOP", "BLMOVE", "BZPOPMIN", "BZPOPMAX", "BLMPOP", "BZMPOP", "XREAD", "XREADGROUP", "WAIT", "WAITAOF", "CLIENT", "SWAPDB", "SAVE", "BGSAVE", "BGREWRITEAOF", "FAILOVER", "CLUSTER", "SELECT", "AUTH", "HELLO", "RESET", "QUIT", "SYNC", "PSYNC"]);

const RESULT_COLUMN: ColumnInfo = { name: "result", type: null, nullable: null, defaultValue: null, isKey: false, generated: false };

interface TypeShape {
  columns: string[];
  key: string[];
}

const SHAPES: Record<string, TypeShape> = {
  string: { columns: ["value"], key: [] },
  hash: { columns: ["field", "value"], key: ["field"] },
  // The value is part of a list entry's identity: positions shift, so a position alone can name another entry.
  list: { columns: ["index", "value"], key: ["index", "value"] },
  set: { columns: ["member"], key: ["member"] },
  zset: { columns: ["member", "score"], key: ["member"] },
  stream: { columns: ["id", "fields"], key: ["id"] },
  "ReJSON-RL": { columns: ["value"], key: [] },
};

// Positions and stream IDs are assigned by Redis, so a form cannot edit them.
function column(name: string, isKey: boolean): ColumnInfo {
  return { name, type: null, nullable: false, defaultValue: null, isKey, generated: name === "index" || name === "id" };
}

// A MULTI reports each command's failure in its own slot and still runs the rest, so check every slot.
function checkExec(results: [Error | null, unknown][] | null): void {
  if (results === null) throw new Error("The key changed during this write, so nothing was changed. Refresh and try again.");
  const failed = results.find(([error]) => error);
  if (failed?.[0]) throw failed[0];
}

// Atomic checks on a list. A plain LSET or LREM acts on whatever sits at a position by then.
const LIST_SET_SCRIPT = "if redis.call('LINDEX',KEYS[1],ARGV[1])==ARGV[2] then redis.call('LSET',KEYS[1],ARGV[1],ARGV[3]) return 1 else return 0 end";
const LIST_REMOVE_SCRIPT = "for i=2,#ARGV,2 do if redis.call('LINDEX',KEYS[1],ARGV[i])~=ARGV[i+1] then return 0 end end for i=2,#ARGV,2 do redis.call('LSET',KEYS[1],ARGV[i],ARGV[1]) end redis.call('LREM',KEYS[1],0,ARGV[1]) return (#ARGV-1)/2";

function matches(text: string, filters: Filter[], name: string): boolean {
  return filters.filter((item) => item.column === name).every((item) => (item.op === "starts" ? text.startsWith(item.value) : text.toLowerCase().includes(item.value.toLowerCase())));
}

class RedisAdapter implements Adapter {
  private readonly clients = new Map<number, Promise<Redis>>();
  private readOnlyCommands: Promise<Map<string, boolean>> | null = null;
  private readonly context: AdapterContext;

  constructor(context: AdapterContext) {
    this.context = context;
  }

  private dbIndex(database: string | undefined): number {
    const text = database || this.context.connection.database || "0";
    const index = Number(text.replace(/^db/, ""));
    if (!Number.isInteger(index) || index < 0) throw new Error(`Not a Redis database number: ${text}`);
    return index;
  }

  private client(database: string | undefined): Promise<Redis> {
    const db = this.dbIndex(database);
    let client = this.clients.get(db);
    if (!client) {
      client = (async () => {
        const { connection, endpoint } = this.context;
        if (!endpoint) throw new Error("Redis needs a host.");
        const { default: IORedis } = await loadDriver<typeof import("ioredis")>("ioredis");
        const options: RedisOptions = {
          host: endpoint.host,
          port: endpoint.port,
          username: connection.user || undefined,
          password: connection.password ?? undefined,
          db,
          lazyConnect: true,
          connectTimeout: 15000,
          commandTimeout: 60000,
          maxRetriesPerRequest: 1,
          enableReadyCheck: false,
          // Pipelines keep the order, and offline commands fail right away instead of waiting.
          enableOfflineQueue: false,
          retryStrategy: () => null,
          tls: connection.tls === "off" ? undefined : { rejectUnauthorized: connection.tls === "verify", ca: connection.caCertificate || undefined, servername: endpoint.tlsServername },
        };
        const instance = new IORedis(options);
        instance.on("error", () => undefined);
        instance.on("end", () => {
          this.clients.delete(db);
        });
        await instance.connect();
        return instance;
      })();
      this.clients.set(db, client);
      client.catch(() => this.clients.delete(db));
    }
    return client;
  }

  async ping() {
    const client = await this.client(undefined);
    const info = await client.info("server");
    const version = /redis_version:(\S+)/.exec(info)?.[1] ?? /valkey_version:(\S+)/.exec(info)?.[1] ?? "unknown";
    return { serverVersion: `Redis ${version}` };
  }

  async listDatabases() {
    const client = await this.client(undefined);
    let total = 16;
    try {
      const reply = (await client.config("GET", "databases")) as unknown as string[];
      total = Number(reply[1] ?? 16) || 16;
    } catch {
      // CONFIG is often disabled on managed servers. Keyspace below still reveals used databases.
    }
    const used = new Set<number>([this.dbIndex(undefined)]);
    for (const match of (await client.info("keyspace")).matchAll(/^db(\d+):/gm)) used.add(Number(match[1]));
    return Array.from({ length: Math.min(total, 64) }, (_, index) => index).filter((index) => used.has(index) || index === 0).map(String);
  }

  async listSchemas() {
    return [];
  }

  async listObjects(scope: Scope, options: { pattern: string; cursor: string | null }): Promise<ObjectPage> {
    const client = await this.client(scope.database);
    // A pattern without a wildcard means "keys containing this text".
    const pattern = options.pattern === "" ? "*" : /[*?[]/.test(options.pattern) ? options.pattern : `*${options.pattern}*`;
    const names: string[] = [];
    let cursor = options.cursor ?? "0";
    // SCAN never blocks the server the way KEYS does. A sparse pattern can need several passes.
    for (let pass = 0; pass < 20 && names.length < 200; pass += 1) {
      const [next, batch] = await client.scan(cursor, "MATCH", pattern, "COUNT", 500);
      names.push(...batch);
      cursor = next;
      if (cursor === "0") break;
    }
    const pipeline = client.pipeline();
    for (const name of names) pipeline.type(name);
    const types = (await pipeline.exec()) ?? [];
    return {
      objects: names.map((name, index) => ({ name, kind: String(types[index]?.[1] ?? "key") })).sort((a, b) => a.name.localeCompare(b.name)),
      nextCursor: cursor === "0" ? null : cursor,
    };
  }

  private async typeOf(client: Redis, name: string): Promise<string> {
    const type = await client.type(name);
    if (type === "none") throw new Error(`The key ${name} does not exist. It may have expired.`);
    return type;
  }

  private shape(type: string): TypeShape {
    return SHAPES[type] ?? { columns: ["value"], key: [] };
  }

  async describe(ref: ObjectRef): Promise<ObjectDetails> {
    const client = await this.client(ref.database);
    const type = await this.typeOf(client, ref.name);
    const shape = this.shape(type);
    const ttl = await client.ttl(ref.name);
    const facts = [
      { label: "Type", value: type },
      { label: "Expires", value: ttl < 0 ? "never" : `in ${ttl} seconds` },
    ];
    const memory = await client.call("MEMORY", "USAGE", ref.name).catch(() => null);
    if (memory !== null) facts.push({ label: "Memory", value: `${String(memory)} bytes` });
    return {
      name: ref.name,
      kind: type,
      columns: shape.columns.map((name) => column(name, shape.key.includes(name))),
      keyColumns: shape.key.length > 0 ? shape.key : ["value"],
      keyReason: null,
      indexes: [],
      foreignKeys: [],
      definition: null,
      facts,
    };
  }

  async read(ref: ObjectRef, query: ReadQuery): Promise<RowPage> {
    const client = await this.client(ref.database);
    const type = await this.typeOf(client, ref.name);
    const shape = this.shape(type);
    const page = await this.readPage(client, ref.name, type, query.limit, query.cursor, query.filters);
    const finished = finishRows(page.rows);
    return {
      columns: shape.columns.map((name) => column(name, shape.key.includes(name))),
      keyColumns: shape.key.length > 0 ? shape.key : ["value"],
      keyReason: null,
      rows: finished.rows,
      cutCells: finished.cutCells,
      truncated: finished.truncated,
      nextCursor: page.nextCursor,
    };
  }

  private async readPage(client: Redis, name: string, type: string, limit: number, cursor: string | null, filters: Filter[]): Promise<{ rows: unknown[][]; nextCursor: string | null }> {
    const pass = (text: string, columnName: string) => matches(text, filters, columnName);
    switch (type) {
      case "string": {
        const value = await client.getBuffer(name);
        const text = value === null ? null : isUtf8(value) ? value.toString("utf8") : value;
        return { rows: [[text]], nextCursor: null };
      }
      case "ReJSON-RL":
        return { rows: [[JSON.parse(String(await client.call("JSON.GET", name)))]], nextCursor: null };
      case "hash": {
        const [next, flat] = await client.hscan(name, cursor ?? "0", "COUNT", limit);
        const rows: unknown[][] = [];
        for (let index = 0; index + 1 < flat.length; index += 2) if (pass(flat[index] ?? "", "field") && pass(flat[index + 1] ?? "", "value")) rows.push([flat[index], flat[index + 1]]);
        return { rows, nextCursor: next === "0" ? null : next };
      }
      case "set": {
        const [next, members] = await client.sscan(name, cursor ?? "0", "COUNT", limit);
        return { rows: members.filter((member) => pass(member, "member")).map((member) => [member]), nextCursor: next === "0" ? null : next };
      }
      case "zset": {
        const [next, flat] = await client.zscan(name, cursor ?? "0", "COUNT", limit);
        const rows: unknown[][] = [];
        for (let index = 0; index + 1 < flat.length; index += 2) if (pass(flat[index] ?? "", "member")) rows.push([flat[index], flat[index + 1]]);
        return { rows, nextCursor: next === "0" ? null : next };
      }
      case "list": {
        const start = cursor === null ? 0 : Number(cursor);
        const values = await client.lrange(name, start, start + limit);
        const rows = values.slice(0, limit).map((value, index) => [start + index, value]).filter((row) => pass(String(row[1]), "value"));
        return { rows, nextCursor: values.length > limit ? String(start + limit) : null };
      }
      case "stream": {
        const entries = (await client.xrange(name, cursor ? `(${cursor}` : "-", "+", "COUNT", limit + 1)) as [string, string[]][];
        const rows = entries.slice(0, limit).map(([id, flat]) => {
          const fields: Record<string, string> = {};
          for (let index = 0; index + 1 < flat.length; index += 2) fields[flat[index] ?? ""] = flat[index + 1] ?? "";
          return [id, fields];
        });
        return { rows, nextCursor: entries.length > limit ? String(rows[rows.length - 1]?.[0]) : null };
      }
      default:
        throw new Error(`Keys of type ${type} are read from the query box.`);
    }
  }

  async count(ref: ObjectRef): Promise<number> {
    const client = await this.client(ref.database);
    const type = await this.typeOf(client, ref.name);
    const lengths: Record<string, () => Promise<number>> = { hash: () => client.hlen(ref.name), list: () => client.llen(ref.name), set: () => client.scard(ref.name), zset: () => client.zcard(ref.name), stream: () => client.xlen(ref.name) };
    return lengths[type]?.() ?? 1;
  }

  async readRow(ref: ObjectRef, key: RowKey): Promise<RowPage> {
    const client = await this.client(ref.database);
    const type = await this.typeOf(client, ref.name);
    const shape = this.shape(type);
    const single = (rows: unknown[][]) => {
      const finished = finishRows(rows, null, Number.MAX_SAFE_INTEGER);
      return { columns: shape.columns.map((name) => column(name, shape.key.includes(name))), keyColumns: shape.key.length > 0 ? shape.key : ["value"], keyReason: null, rows: finished.rows, cutCells: [], truncated: false, nextCursor: null };
    };
    switch (type) {
      case "hash":
        return single([[key.field, await client.hget(ref.name, String(key.field))]]);
      case "list":
        return single([[key.index, await client.lindex(ref.name, Number(key.index))]]);
      case "set":
        return single([[key.member]]);
      case "zset":
        return single([[key.member, await client.zscore(ref.name, String(key.member))]]);
      case "stream":
        return single(((await client.xrange(ref.name, String(key.id), String(key.id))) as [string, string[]][]).map(([id, flat]) => [id, Object.fromEntries(flat.flatMap((_, index) => (index % 2 === 0 ? [[flat[index], flat[index + 1]]] : [])))]));
      default:
        return single((await this.readPage(client, ref.name, type, 1, null, [])).rows);
    }
  }

  async planWrite(ref: ObjectRef, op: WriteOp): Promise<WritePlan> {
    const client = await this.client(ref.database);
    const type = await this.typeOf(client, ref.name);
    const text = (value: unknown) => (typeof value === "string" ? value : value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));
    const plan = (preview: string, run: () => Promise<number>): WritePlan => ({ preview, run });

    if (op.kind === "insert") {
      const v = op.values;
      switch (type) {
        case "hash":
          return plan(`HSET ${ref.name} ${text(v.field)} ${text(v.value)}`, async () => {
            await client.hset(ref.name, text(v.field), text(v.value));
            return 1;
          });
        case "list":
          return plan(`RPUSH ${ref.name} ${text(v.value)}`, async () => {
            await client.rpush(ref.name, text(v.value));
            return 1;
          });
        case "set":
          return plan(`SADD ${ref.name} ${text(v.member)}`, () => client.sadd(ref.name, text(v.member)));
        case "zset":
          return plan(`ZADD ${ref.name} ${text(v.score)} ${text(v.member)}`, () => client.zadd(ref.name, text(v.score), text(v.member)).then(Number));
        case "stream": {
          const fields = (typeof v.fields === "string" ? JSON.parse(v.fields) : v.fields) as Record<string, unknown>;
          const flat = Object.entries(fields).flatMap(([name, value]) => [name, text(value)]);
          return plan(`XADD ${ref.name} * ${flat.join(" ")}`, async () => {
            await client.xadd(ref.name, "*", ...flat);
            return 1;
          });
        }
        default:
          throw new Error(`A ${type} key holds one value. Edit it instead.`);
      }
    }

    if (op.kind === "update") {
      const changes = op.changes;
      switch (type) {
        case "string":
          // KEEPTTL so editing a value does not make an expiring key permanent.
          return plan(`SET ${ref.name} ${text(changes.value)} KEEPTTL`, async () => {
            await client.set(ref.name, text(changes.value), "KEEPTTL");
            return 1;
          });
        case "ReJSON-RL":
          return plan(`JSON.SET ${ref.name} $ ${text(changes.value)}`, async () => {
            await client.call("JSON.SET", ref.name, "$", text(changes.value));
            return 1;
          });
        case "hash": {
          const field = text(op.key.field);
          const nextField = "field" in changes ? text(changes.field) : field;
          return plan(`HSET ${ref.name} ${nextField} ...`, async () => {
            const stored = await client.hget(ref.name, field);
            // Also refuses a field name cut for display, which would otherwise create a new field.
            if (stored === null) throw new Error("That field no longer exists. Refresh and try again.");
            const value = "value" in changes ? text(changes.value) : stored;
            const batch = client.multi().hset(ref.name, nextField, value);
            if (nextField !== field) batch.hdel(ref.name, field);
            checkExec(await batch.exec());
            return 1;
          });
        }
        case "list":
          if ("index" in changes) throw new Error("A list position cannot be edited. Change the value instead.");
          if (!("value" in changes)) throw new Error("Nothing changed.");
          return plan(`LSET ${ref.name} ${text(op.key.index)} ${text(changes.value)}`, async () => {
            const done = await client.eval(LIST_SET_SCRIPT, 1, ref.name, text(op.key.index), text(op.key.value), text(changes.value));
            if (Number(done) !== 1) throw new Error("This list changed, so that position holds something else now. Nothing was changed. Refresh and try again.");
            return 1;
          });
        case "zset": {
          const member = text(op.key.member);
          const nextMember = "member" in changes ? text(changes.member) : member;
          return plan(`ZADD ${ref.name} ${text(changes.score)} ${nextMember}`, async () => {
            const score = "score" in changes ? text(changes.score) : await client.zscore(ref.name, member);
            if (score === null) throw new Error("That member no longer exists. Refresh and try again.");
            // Checked first: in a MULTI a bad score fails alone, and the removal after it would still run.
            if (Number.isNaN(Number(score))) throw new Error(`${score} is not a score. Use a number.`);
            const batch = client.multi().zadd(ref.name, score, nextMember);
            if (nextMember !== member) batch.zrem(ref.name, member);
            checkExec(await batch.exec());
            return 1;
          });
        }
        case "set": {
          const member = text(op.key.member);
          const nextMember = text(changes.member);
          return plan(`SREM ${ref.name} ${member} + SADD ${ref.name} ${nextMember}`, async () => {
            checkExec(await client.multi().srem(ref.name, member).sadd(ref.name, nextMember).exec());
            return 1;
          });
        }
        default:
          throw new Error(`Entries of a ${type} key cannot be edited, only added and removed.`);
      }
    }

    const keys = op.keys;
    const list = (command: string, values: string[]) => `${command} ${ref.name} ${values.slice(0, 20).join(" ")}${values.length > 20 ? ` ...and ${values.length - 20} more` : ""}`;
    switch (type) {
      case "string":
      case "ReJSON-RL":
        return plan(`DEL ${ref.name}`, () => client.del(ref.name));
      case "hash": {
        const fields = keys.map((key) => text(key.field));
        return plan(list("HDEL", fields), () => client.hdel(ref.name, ...fields));
      }
      case "set": {
        const members = keys.map((key) => text(key.member));
        return plan(list("SREM", members), () => client.srem(ref.name, ...members));
      }
      case "zset": {
        const members = keys.map((key) => text(key.member));
        return plan(list("ZREM", members), () => client.zrem(ref.name, ...members));
      }
      case "stream": {
        const ids = keys.map((key) => text(key.id));
        return plan(list("XDEL", ids), () => client.xdel(ref.name, ...ids));
      }
      case "list": {
        // A list has no delete by position. The usual method is to mark each position and remove the
        // marker, all in one atomic script, which first checks every position still holds what was shown.
        const pairs = keys.flatMap((key) => [text(key.index), text(key.value)]);
        const marker = `__datawise_removed_${randomUUID()}__`;
        return plan(list("Remove positions from", keys.map((key) => text(key.index))), async () => {
          const done = await client.eval(LIST_REMOVE_SCRIPT, 1, ref.name, marker, ...pairs);
          if (Number(done) !== keys.length) throw new Error("This list changed, so those positions hold something else now. Nothing was removed. Refresh and try again.");
          return keys.length;
        });
      }
      default:
        throw new Error(`Cannot remove entries of a ${type} key here.`);
    }
  }

  async planDestroy(ref: ObjectRef, action: "drop" | "truncate"): Promise<WritePlan> {
    if (action === "truncate") throw new Error("A Redis key is deleted, not truncated.");
    const client = await this.client(ref.database);
    return { preview: `DEL ${ref.name}`, run: () => client.del(ref.name) };
  }

  // Reads the server's command table. A command the server does not list is treated as a write.
  private commandFlags(client: Redis): Promise<Map<string, boolean>> {
    this.readOnlyCommands ??= (client.call("COMMAND") as Promise<unknown[][]>).then((table) => {
      const flags = new Map<string, boolean>();
      const add = (entry: unknown[]) => {
        const entryFlags = (entry[2] as unknown[]).map((flag) => String(flag).toLowerCase());
        const safe = entryFlags.includes("readonly") && !["write", "admin", "blocking", "noscript"].some((flag) => entryFlags.includes(flag));
        flags.set(String(entry[0]).toUpperCase(), safe);
        // Container commands such as XINFO list their subcommands, named like "xinfo|stream".
        for (const sub of (entry[9] as unknown[][] | undefined) ?? []) add(sub);
      };
      for (const entry of table) add(entry);
      return flags;
    });
    // A failed lookup must not be remembered, or the query box stays broken until a reconnect.
    this.readOnlyCommands.catch(() => {
      this.readOnlyCommands = null;
    });
    return this.readOnlyCommands;
  }

  // Redis has no read-only session to fall back on, so the class decided here is final.
  async parse(text: string): Promise<ParsedStatement[]> {
    const client = await this.client(undefined);
    const flags = await this.commandFlags(client);
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .map((line) => {
        const [first, second] = splitCommandLine(line);
        const head = first?.toUpperCase() ?? "";
        const safe = flags.get(`${head}|${second?.toUpperCase() ?? ""}`) ?? flags.get(head);
        return { text: line, class: !NEVER_READ.has(head) && safe === true ? "read" : "write" };
      });
  }

  async run(statements: ParsedStatement[], context: RunContext): Promise<QueryResult[]> {
    const client = await this.client(context.scope.database);
    const results: QueryResult[] = [];
    for (const statement of statements) {
      if (context.signal.aborted) throw new PartialRunError("Cancelled.", results);
      const started = Date.now();
      const [command, ...args] = splitCommandLine(statement.text);
      if (!command) continue;
      const upper = command.toUpperCase();
      if (["SELECT", "SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE", "MONITOR", "MULTI", "EXEC", "WATCH", "UNWATCH", "AUTH", "HELLO", "RESET", "QUIT", "CLIENT"].includes(upper)) throw new PartialRunError(`${upper} changes this shared connection, so it is not available here. Pick the database in the tree instead.`, results);
      try {
        const reply: unknown = await client.call(command, ...args);
        const list = Array.isArray(reply) ? reply : [reply];
        const finished = finishRows(list.map((item) => [Array.isArray(item) ? item : item]), context.limit);
        results.push({ statement: statement.text, columns: [RESULT_COLUMN], rows: finished.rows, cutCells: finished.cutCells, truncated: finished.truncated, affected: null, durationMs: Date.now() - started, message: null });
      } catch (error) {
        throw new PartialRunError(errorMessage(error), results);
      }
    }
    return results;
  }

  async stream(source: StreamSource, signal: AbortSignal, onBatch: (batch: StreamBatch) => Promise<boolean>): Promise<void> {
    if (source.kind === "query") {
      const statements = await this.parse(source.text);
      if (statements.length !== 1 || statements[0]?.class !== "read") throw new Error("Export runs one read command.");
      const client = await this.client(source.scope.database);
      const [command, ...args] = splitCommandLine(statements[0].text);
      const reply: unknown = await client.call(command ?? "", ...args);
      const list = Array.isArray(reply) ? reply : [reply];
      await onBatch({ columns: [RESULT_COLUMN], rows: list.map((item) => [item]) });
      return;
    }
    const client = await this.client(source.ref.database);
    const type = await this.typeOf(client, source.ref.name);
    const shape = this.shape(type);
    const columns = shape.columns.map((name) => column(name, shape.key.includes(name)));
    let cursor: string | null = null;
    do {
      if (signal.aborted) throw new Error("Cancelled.");
      const page = await this.readPage(client, source.ref.name, type, STREAM_BATCH, cursor, source.filters);
      if (page.rows.length > 0 && !(await onBatch({ columns, rows: page.rows }))) return;
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  async importInto(ref: ObjectRef, columns: string[], produce: (insert: (rows: unknown[][]) => Promise<void>) => Promise<void>): Promise<void> {
    await produce(async (rows) => {
      for (const row of rows) {
        const values: Record<string, unknown> = {};
        for (const [index, name] of columns.entries()) values[name] = row[index];
        await (await this.planWrite(ref, { kind: "insert", values })).run();
      }
    });
  }

  async close() {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map(async (client) => (await client).quit()));
  }
}

function isUtf8(value: Buffer): boolean {
  return Buffer.from(value.toString("utf8"), "utf8").equals(value);
}

export async function createRedis(context: AdapterContext): Promise<Adapter> {
  return new RedisAdapter(context);
}
