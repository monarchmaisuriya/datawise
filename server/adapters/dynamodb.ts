import type { AttributeValue, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { Filter, ObjectDetails, ObjectPage, ObjectRef, QueryResult, ReadQuery, RowKey, RowPage, Scope, WriteOp } from "../../shared/contracts";
import { finishRows, fromCell, positionsOf } from "../cells";
import { loadDriver } from "../drivers";
import { errorMessage } from "../errors";
import { splitStatements } from "../sql-script";
import { PartialRunError, renderLiteral, STREAM_BATCH } from "./sql-base";
import type { Adapter, AdapterContext, ParsedStatement, RunContext, StreamBatch, StreamSource, WritePlan } from "./types";

type Sdk = typeof import("@aws-sdk/client-dynamodb");
type Item = Record<string, AttributeValue>;
type Keys = { names: string[]; types: Record<string, string> };

const ALLOWED_JSON_OPS = new Set(["CreateTable", "DeleteTable", "DescribeTable"]);
// DynamoDB's own limit on one BatchWriteItem call.
const BATCH_WRITE_LIMIT = 25;

// Text from a form takes the attribute type the table declares for keys; other values keep their JSON type.
function toAttribute(value: unknown, declaredType?: string): AttributeValue {
  const decoded = fromCell(value);
  if (declaredType === "N") return { N: String(decoded) };
  if (declaredType === "S") return { S: String(decoded) };
  if (decoded === null || decoded === undefined) return { NULL: true };
  if (typeof decoded === "string") return { S: decoded };
  if (typeof decoded === "number" || typeof decoded === "bigint") return { N: String(decoded) };
  if (typeof decoded === "boolean") return { BOOL: decoded };
  if (decoded instanceof Uint8Array) return { B: decoded };
  if (Array.isArray(decoded)) return { L: decoded.map((item) => toAttribute(item)) };
  return { M: Object.fromEntries(Object.entries(decoded).map(([key, item]) => [key, toAttribute(item)])) };
}

// Numbers stay text when a JavaScript number would round them.
function fromAttribute(attribute: AttributeValue): unknown {
  if (attribute.S !== undefined) return attribute.S;
  if (attribute.N !== undefined) {
    const number = Number(attribute.N);
    return Number.isSafeInteger(number) || (!Number.isInteger(number) && String(number) === attribute.N) ? number : attribute.N;
  }
  if (attribute.BOOL !== undefined) return attribute.BOOL;
  if (attribute.NULL !== undefined) return null;
  if (attribute.B !== undefined) return attribute.B;
  if (attribute.L !== undefined) return attribute.L.map(fromAttribute);
  if (attribute.M !== undefined) return Object.fromEntries(Object.entries(attribute.M).map(([key, item]) => [key, fromAttribute(item)]));
  if (attribute.SS !== undefined) return attribute.SS;
  if (attribute.NS !== undefined) return attribute.NS;
  if (attribute.BS !== undefined) return attribute.BS;
  return null;
}

function itemsToRows(items: Item[], first: string[]): { names: string[]; rows: unknown[][] } {
  const seen = new Map<string, null>(first.map((name) => [name, null]));
  for (const item of items) for (const name of Object.keys(item)) seen.set(name, null);
  const names = [...seen.keys()];
  return { names, rows: items.map((item) => names.map((name) => (item[name] ? fromAttribute(item[name]) : null))) };
}

// An edit keeps the attribute's current type where the new value fits it. Otherwise a number shown as
// text, because it is too long for JavaScript, would come back as a string, and a set would become a list.
function likeCurrent(value: unknown, current: AttributeValue | undefined): AttributeValue {
  const decoded = fromCell(value);
  if (current?.N !== undefined && (typeof decoded === "string" || typeof decoded === "number") && decoded !== "" && !Number.isNaN(Number(decoded))) return { N: String(decoded) };
  if (Array.isArray(decoded)) {
    if (current?.SS !== undefined) return { SS: decoded.map(String) };
    if (current?.NS !== undefined) return { NS: decoded.map(String) };
  }
  return toAttribute(decoded);
}

class DynamoAdapter implements Adapter {
  private clientPromise: Promise<{ client: DynamoDBClient; sdk: Sdk }> | null = null;
  private readonly context: AdapterContext;

  constructor(context: AdapterContext) {
    this.context = context;
  }

  private get(): Promise<{ client: DynamoDBClient; sdk: Sdk }> {
    this.clientPromise ??= (async () => {
      const { connection } = this.context;
      const sdk = await loadDriver<Sdk>("@aws-sdk/client-dynamodb");
      const client = new sdk.DynamoDBClient({
        region: connection.region || "us-east-1",
        endpoint: connection.endpoint || undefined,
        // Blank key ID means the daemon's own AWS credentials: its environment or profile.
        credentials: connection.accessKeyId ? { accessKeyId: connection.accessKeyId, secretAccessKey: connection.password ?? "" } : undefined,
        requestHandler: { requestTimeout: 25000, connectionTimeout: 10000 } as never,
      });
      return { client, sdk };
    })();
    return this.clientPromise;
  }

  async ping() {
    const { client, sdk } = await this.get();
    await client.send(new sdk.ListTablesCommand({ Limit: 1 }));
    return { serverVersion: this.context.connection.endpoint ? `DynamoDB at ${this.context.connection.endpoint}` : `DynamoDB in ${this.context.connection.region || "us-east-1"}` };
  }

  async listDatabases() {
    return [];
  }

  async listSchemas() {
    return [];
  }

  async listObjects(_scope: Scope, options: { pattern: string; cursor: string | null }): Promise<ObjectPage> {
    const { client, sdk } = await this.get();
    const result = await client.send(new sdk.ListTablesCommand({ ExclusiveStartTableName: options.cursor ?? undefined, Limit: 100 }));
    const needle = options.pattern.toLowerCase();
    return { objects: (result.TableNames ?? []).filter((name) => !needle || name.toLowerCase().includes(needle)).map((name) => ({ name, kind: "table" })), nextCursor: result.LastEvaluatedTableName ?? null };
  }

  private async keys(name: string): Promise<Keys & { description: import("@aws-sdk/client-dynamodb").TableDescription }> {
    const { client, sdk } = await this.get();
    const table = (await client.send(new sdk.DescribeTableCommand({ TableName: name }))).Table;
    if (!table) throw new Error(`${name} was not found.`);
    const types: Record<string, string> = {};
    for (const attribute of table.AttributeDefinitions ?? []) if (attribute.AttributeName && attribute.AttributeType) types[attribute.AttributeName] = attribute.AttributeType;
    return { names: (table.KeySchema ?? []).map((key) => key.AttributeName ?? ""), types, description: table };
  }

  async describe(ref: ObjectRef): Promise<ObjectDetails> {
    const { names, types, description } = await this.keys(ref.name);
    const { client, sdk } = await this.get();
    const sample = await client.send(new sdk.ScanCommand({ TableName: ref.name, Limit: 50 }));
    const { names: columns } = itemsToRows((sample.Items ?? []) as Item[], names);
    return {
      name: ref.name,
      kind: "table",
      columns: columns.map((name) => ({ name, type: types[name] ?? null, nullable: !names.includes(name), defaultValue: null, isKey: names.includes(name), generated: false })),
      keyColumns: names,
      keyReason: null,
      indexes: (description.GlobalSecondaryIndexes ?? []).map((index) => ({ name: index.IndexName ?? "", columns: (index.KeySchema ?? []).map((key) => key.AttributeName ?? ""), unique: false })),
      foreignKeys: [],
      definition: JSON.stringify({ KeySchema: description.KeySchema, AttributeDefinitions: description.AttributeDefinitions, BillingMode: description.BillingModeSummary?.BillingMode }, null, 2),
      facts: [
        { label: "Approximate items", value: String(description.ItemCount ?? "unknown") },
        { label: "Status", value: String(description.TableStatus ?? "unknown") },
      ],
    };
  }

  private compile(filters: Filter[]) {
    if (filters.length === 0) return {};
    const names: Record<string, string> = {};
    const values: Item = {};
    const parts = filters.map((item, index) => {
      names[`#f${index}`] = item.column;
      const attribute = `#f${index}`;
      const value = `:v${index}`;
      // A number is matched as a number, because S and N never compare equal in DynamoDB.
      const typed: AttributeValue = item.value !== "" && !Number.isNaN(Number(item.value)) ? { N: item.value } : { S: item.value };
      switch (item.op) {
        case "null":
          return `attribute_not_exists(${attribute})`;
        case "notnull":
          return `attribute_exists(${attribute})`;
        case "contains":
          values[value] = { S: item.value };
          return `contains(${attribute}, ${value})`;
        case "starts":
          values[value] = { S: item.value };
          return `begins_with(${attribute}, ${value})`;
        default:
          values[value] = typed;
          return `${attribute} ${{ eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" }[item.op]} ${value}`;
      }
    });
    return { FilterExpression: parts.join(" AND "), ExpressionAttributeNames: names, ExpressionAttributeValues: Object.keys(values).length > 0 ? values : undefined };
  }

  // An agent's read. Datawise builds this query itself, so no agent-written text reaches the database.
  readIsolated(ref: ObjectRef, query: ReadQuery, cellLimit: number): Promise<RowPage> {
    return this.read(ref, query, cellLimit, true);
  }

  async read(ref: ObjectRef, query: ReadQuery, cellLimit: number, bytesAsSize = false): Promise<RowPage> {
    if (query.sort) throw new Error("DynamoDB tables cannot be sorted by a scan.");
    const { client, sdk } = await this.get();
    const { names, types } = await this.keys(ref.name);
    const result = await client.send(new sdk.ScanCommand({ TableName: ref.name, Limit: query.limit, ExclusiveStartKey: query.cursor ? (JSON.parse(query.cursor) as Item) : undefined, ...this.compile(query.filters) }));
    const { names: columns, rows } = itemsToRows((result.Items ?? []) as Item[], names);
    const finished = finishRows(rows, null, cellLimit, bytesAsSize, positionsOf(columns, names));
    return {
      columns: columns.map((name) => ({ name, type: types[name] ?? null, nullable: !names.includes(name), defaultValue: null, isKey: names.includes(name), generated: false })),
      keyColumns: names,
      keyReason: null,
      rows: finished.rows,
      cutCells: finished.cutCells,
      truncated: finished.truncated,
      nextCursor: result.LastEvaluatedKey ? JSON.stringify(result.LastEvaluatedKey) : null,
    };
  }

  async count(ref: ObjectRef, filters: Filter[], timeoutMs: number): Promise<number> {
    const { client, sdk } = await this.get();
    // One deadline for every page, so a large table's scan stops instead of running on, billed, after the answer.
    const abortSignal = AbortSignal.timeout(timeoutMs);
    let total = 0;
    let start: Item | undefined;
    do {
      const result = await client.send(new sdk.ScanCommand({ TableName: ref.name, Select: "COUNT", ExclusiveStartKey: start, ...this.compile(filters) }), { abortSignal });
      total += result.Count ?? 0;
      start = result.LastEvaluatedKey as Item | undefined;
    } while (start);
    return total;
  }

  private keyItem(key: RowKey, keys: Keys): Item {
    const given = Object.keys(key);
    if (given.length !== keys.names.length || !keys.names.every((name) => given.includes(name))) throw new Error(`An item is identified by exactly: ${keys.names.join(", ")}.`);
    return Object.fromEntries(
      keys.names.map((name) => {
        if (key[name] === null || key[name] === undefined) throw new Error(`The key attribute ${name} has no value.`);
        return [name, toAttribute(key[name], keys.types[name])];
      }),
    );
  }

  async readRow(ref: ObjectRef, key: RowKey): Promise<RowPage> {
    const { client, sdk } = await this.get();
    const keys = await this.keys(ref.name);
    const result = await client.send(new sdk.GetItemCommand({ TableName: ref.name, Key: this.keyItem(key, keys), ConsistentRead: true }));
    const { names, rows } = itemsToRows(result.Item ? [result.Item as Item] : [], keys.names);
    const finished = finishRows(rows, null, Number.MAX_SAFE_INTEGER);
    return { columns: names.map((name) => ({ name, type: keys.types[name] ?? null, nullable: !keys.names.includes(name), defaultValue: null, isKey: keys.names.includes(name), generated: false })), keyColumns: keys.names, keyReason: null, rows: finished.rows, cutCells: [], truncated: false, nextCursor: null };
  }

  async planWrite(ref: ObjectRef, op: WriteOp): Promise<WritePlan> {
    const { client, sdk } = await this.get();
    const keys = await this.keys(ref.name);
    // A condition on the key keeps a put from replacing an item, and an update from reviving a deleted one.
    const exists = `attribute_exists(#k0)`;
    const keyNames = { "#k0": keys.names[0] ?? "" };
    if (op.kind === "insert") {
      const item: Item = Object.fromEntries(Object.entries(op.values).map(([name, value]) => [name, toAttribute(value, keys.types[name])]));
      for (const name of keys.names) if (!item[name]) throw new Error(`Give a value for the key: ${name}.`);
      return {
        preview: `PutItem ${ref.name} ${JSON.stringify(op.values)}`,
        run: async () => {
          await client.send(new sdk.PutItemCommand({ TableName: ref.name, Item: item, ConditionExpression: "attribute_not_exists(#k0)", ExpressionAttributeNames: keyNames }));
          return 1;
        },
      };
    }
    if (op.kind === "update") {
      const names = Object.keys(op.changes);
      if (names.length === 0) throw new Error("Nothing changed.");
      for (const name of names) if (keys.names.includes(name)) throw new Error(`The key attribute ${name} cannot be changed. Insert a new item and delete this one instead.`);
      const assign = names.map((_, index) => `#n${index} = :v${index}`).join(", ");
      const attributeNames: Record<string, string> = { ...keyNames };
      const values: Item = {};
      for (const [index, name] of names.entries()) {
        attributeNames[`#n${index}`] = name;
        values[`:v${index}`] = toAttribute(op.changes[name]);
      }
      const Key = this.keyItem(op.key, keys);
      const current = (await client.send(new sdk.GetItemCommand({ TableName: ref.name, Key, ConsistentRead: true }))).Item as Item | undefined;
      for (const [index, name] of names.entries()) values[`:v${index}`] = likeCurrent(op.changes[name], current?.[name]);
      return {
        preview: `UpdateItem ${ref.name} ${JSON.stringify(op.key)} SET ${names.map((name) => `${name} = ${renderLiteral(op.changes[name])}`).join(", ")}`,
        run: async () => {
          try {
            await client.send(new sdk.UpdateItemCommand({ TableName: ref.name, Key, UpdateExpression: `SET ${assign}`, ConditionExpression: exists, ExpressionAttributeNames: attributeNames, ExpressionAttributeValues: values }));
          } catch (error) {
            if ((error as Error).name === "ConditionalCheckFailedException") throw new Error("No item matched its key. Someone may have deleted it; refresh and try again.");
            throw error;
          }
          return 1;
        },
      };
    }
    const items = op.keys.map((key) => this.keyItem(key, keys));
    const shown = op.keys.slice(0, 20).map((key) => `DeleteItem ${ref.name} ${JSON.stringify(key)}`);
    if (op.keys.length > 20) shown.push(`...and ${op.keys.length - 20} more`);
    return {
      preview: shown.join("\n"),
      run: async () => {
        for (const Key of items) await client.send(new sdk.DeleteItemCommand({ TableName: ref.name, Key }));
        return items.length;
      },
    };
  }

  async planDestroy(ref: ObjectRef, action: "drop" | "truncate"): Promise<WritePlan> {
    if (action === "truncate") throw new Error("DynamoDB has no truncate. Delete the table and create it again.");
    const { client, sdk } = await this.get();
    return {
      preview: `DeleteTable ${ref.name}`,
      run: async () => {
        await client.send(new sdk.DeleteTableCommand({ TableName: ref.name }));
        return 0;
      },
    };
  }

  // Text is either PartiQL statements, or one JSON object naming an allowed table operation.
  async parse(text: string): Promise<ParsedStatement[]> {
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) return [{ text: trimmed, class: "write" }];
    return splitStatements(trimmed, "cassandra").map((statement) => ({ text: statement.text, class: /^select\s/i.test(statement.text) ? "read" : "write" }));
  }

  private async runJson(text: string): Promise<unknown> {
    const { client, sdk } = await this.get();
    const parsed = JSON.parse(text) as Record<string, Record<string, unknown>>;
    const [operation, ...others] = Object.keys(parsed);
    if (!operation || others.length > 0 || !ALLOWED_JSON_OPS.has(operation)) throw new Error(`Give one of: ${[...ALLOWED_JSON_OPS].join(", ")}.`);
    const input = parsed[operation] as never;
    if (operation === "CreateTable") return (await client.send(new sdk.CreateTableCommand(input))).TableDescription;
    if (operation === "DeleteTable") return (await client.send(new sdk.DeleteTableCommand(input))).TableDescription;
    return (await client.send(new sdk.DescribeTableCommand(input))).Table;
  }

  async run(statements: ParsedStatement[], context: RunContext): Promise<QueryResult[]> {
    const { client, sdk } = await this.get();
    const results: QueryResult[] = [];
    const blank = { type: null, nullable: null, defaultValue: null, isKey: false, generated: false };
    for (const statement of statements) {
      if (context.signal.aborted) throw new PartialRunError("Cancelled.", results);
      const started = Date.now();
      try {
        if (statement.text.startsWith("{")) {
          const response = await this.runJson(statement.text);
          const finished = finishRows([[response]], null, context.cellLimit, context.bytesAsSize);
          results.push({ statement: statement.text, columns: [{ ...blank, name: "result" }], rows: finished.rows, cutCells: finished.cutCells, truncated: false, affected: null, durationMs: Date.now() - started, message: null });
          continue;
        }
        const items: Item[] = [];
        let token: string | undefined;
        let truncated = false;
        do {
          const result = await client.send(new sdk.ExecuteStatementCommand({ Statement: statement.text, NextToken: token }), { abortSignal: context.signal });
          items.push(...((result.Items ?? []) as Item[]));
          token = result.NextToken;
          if (items.length > context.limit) {
            truncated = true;
            break;
          }
        } while (token);
        const { names, rows } = itemsToRows(items.slice(0, context.limit), []);
        const finished = finishRows(rows, null, context.cellLimit, context.bytesAsSize);
        results.push({ statement: statement.text, columns: names.map((name) => ({ ...blank, name })), rows: finished.rows, cutCells: finished.cutCells, truncated: truncated || finished.truncated, affected: null, durationMs: Date.now() - started, message: null });
      } catch (error) {
        throw new PartialRunError(errorMessage(error), results);
      }
    }
    return results;
  }

  async stream(source: StreamSource, signal: AbortSignal, onBatch: (batch: StreamBatch) => Promise<boolean>): Promise<void> {
    const { client, sdk } = await this.get();
    const blank = { type: null, nullable: null, defaultValue: null, isKey: false, generated: false };
    const seen: string[] = [];
    const emit = async (items: Item[]) => {
      const { names, rows } = itemsToRows(items, seen);
      seen.splice(0, seen.length, ...names);
      return onBatch({ columns: names.map((name) => ({ ...blank, name })), rows });
    };
    if (source.kind === "object") {
      let start: Item | undefined;
      do {
        if (signal.aborted) throw new Error("Cancelled.");
        const result = await client.send(new sdk.ScanCommand({ TableName: source.ref.name, Limit: STREAM_BATCH, ExclusiveStartKey: start, ...this.compile(source.filters) }), { abortSignal: signal });
        if ((result.Items?.length ?? 0) > 0 && !(await emit(result.Items as Item[]))) return;
        start = result.LastEvaluatedKey as Item | undefined;
      } while (start);
      return;
    }
    const statements = await this.parse(source.text);
    if (statements.length !== 1 || statements[0]?.class !== "read") throw new Error("Export runs one SELECT.");
    let token: string | undefined;
    do {
      if (signal.aborted) throw new Error("Cancelled.");
      const result = await client.send(new sdk.ExecuteStatementCommand({ Statement: statements[0].text, NextToken: token }), { abortSignal: signal });
      if ((result.Items?.length ?? 0) > 0 && !(await emit(result.Items as Item[]))) return;
      token = result.NextToken;
    } while (token);
  }

  async importInto(ref: ObjectRef, columns: string[], produce: (insert: (rows: unknown[][]) => Promise<void>) => Promise<void>): Promise<void> {
    const { client, sdk } = await this.get();
    const keys = await this.keys(ref.name);
    await produce(async (rows) => {
      for (let start = 0; start < rows.length; start += BATCH_WRITE_LIMIT) {
        const requests = rows.slice(start, start + BATCH_WRITE_LIMIT).map((row) => ({ PutRequest: { Item: Object.fromEntries(columns.flatMap((name, index) => (row[index] === undefined ? [] : [[name, toAttribute(row[index], keys.types[name])]]))) as Item } }));
        let pending: typeof requests | undefined = requests;
        // DynamoDB may hand back items it did not write. Dropping them would lose rows silently.
        for (let attempt = 0; pending && pending.length > 0; attempt += 1) {
          if (attempt > 8) throw new Error("DynamoDB kept refusing part of the batch. Some rows were written before this.");
          if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
          const result: { UnprocessedItems?: Record<string, unknown[]> } = await client.send(new sdk.BatchWriteItemCommand({ RequestItems: { [ref.name]: pending } }));
          pending = result.UnprocessedItems?.[ref.name] as typeof requests | undefined;
        }
      }
    });
  }

  async close() {
    const current = this.clientPromise;
    this.clientPromise = null;
    if (current) (await current).client.destroy();
  }
}

export async function createDynamodb(context: AdapterContext): Promise<Adapter> {
  return new DynamoAdapter(context);
}

