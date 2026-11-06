import type { Filter, ObjectDetails, ObjectPage, ObjectRef, QueryResult, ReadQuery, RowKey, RowPage, Scope, Sort, WriteOp } from "../../shared/contracts";
import { finishRows } from "../cells";
import { errorMessage } from "../errors";
import { tlsClientOptions } from "../tls";
import { httpCall, type HttpTarget } from "../http";
import { PartialRunError, STREAM_BATCH } from "./sql-base";
import type { Adapter, AdapterContext, ParsedStatement, RunContext, StreamBatch, StreamSource, WritePlan } from "./types";

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"]);
// POST endpoints that only read. Everything else that is not GET or HEAD is a write.
const READ_POST = /^\/(?:(?:_all|[^_/][^/]*)\/)?_(?:search|count|msearch|mget|validate\/query|field_caps|sql|terms_enum|explain\/[^/]+)(?:\/|$)/;
// GET endpoints that have side effects or expose server internals' control paths.
const UNSAFE_GET = /\/_(?:close|open|shutdown|snapshot\/.+\/_restore)\b/;
const ID_COLUMN = "_id";

export function classifyRequest(method: string, target: string): "read" | "write" {
  // Only the path decides. A query string can hold any text, including something that looks like a path.
  const path = target.split("?")[0] ?? "";
  // Paths the server would normalize or decode to something else are not proved to be reads.
  if (path.includes("..") || path.includes("%")) return "write";
  if ((method === "GET" || method === "HEAD") && !UNSAFE_GET.test(path)) return "read";
  if (method === "POST" && READ_POST.test(path)) return "read";
  return "write";
}

// Reads the Kibana console form: a request line, then an optional JSON body or bulk lines.
export function splitConsole(text: string): { method: string; path: string; body: string | null; raw: string }[] {
  const requests: { method: string; path: string; body: string | null; raw: string }[] = [];
  let current: { method: string; path: string; lines: string[]; raw: string[] } | null = null;
  const close = () => {
    if (!current) return;
    const body = current.lines.join("\n").trim();
    requests.push({ method: current.method, path: current.path, body: body === "" ? null : body, raw: current.raw.join("\n") });
    current = null;
  };
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(line);
    if (match?.[1] && match[2] && METHODS.has(match[1].toUpperCase())) {
      close();
      const path = match[2].startsWith("/") ? match[2] : `/${match[2]}`;
      current = { method: match[1].toUpperCase(), path, lines: [], raw: [line] };
    } else if (current) {
      current.lines.push(line);
      current.raw.push(line);
    } else if (line.trim() !== "") throw new Error(`Start with a method and path, like GET /my-index/_search. Could not read: ${line.slice(0, 80)}`);
  }
  close();
  return requests;
}

function flatten(source: Record<string, unknown>): Record<string, unknown> {
  return source;
}

class ElasticAdapter implements Adapter {
  private readonly target: HttpTarget;

  constructor(context: AdapterContext) {
    const { connection, endpoint } = context;
    if (!endpoint) throw new Error("Elasticsearch needs a host.");
    const headers: Record<string, string> = { accept: "application/json" };
    if (connection.apiKey) headers.authorization = `ApiKey ${connection.apiKey}`;
    else if (connection.user) headers.authorization = `Basic ${Buffer.from(`${connection.user}:${connection.password ?? ""}`).toString("base64")}`;
    this.target = {
      protocol: connection.tls === "off" ? "http:" : "https:",
      host: endpoint.host,
      port: endpoint.port,
      tls: tlsClientOptions(connection, endpoint),
      headers,
    };
  }

  private async call(method: string, path: string, body: unknown = null, options: { signal?: AbortSignal; contentType?: string; timeoutMs?: number } = {}): Promise<unknown> {
    const text = body === null ? null : typeof body === "string" ? body : JSON.stringify(body);
    const response = await httpCall(this.target, method, path, text, options);
    if (response.status >= 400) {
      let reason = response.body.slice(0, 1000);
      try {
        const parsed = JSON.parse(response.body) as { error?: { reason?: string; type?: string } | string };
        if (typeof parsed.error === "string") reason = parsed.error;
        else if (parsed.error?.reason) reason = `${parsed.error.type ?? "error"}: ${parsed.error.reason}`;
      } catch {
        // Not JSON; the raw text is the best explanation available.
      }
      throw new Error(`${response.status}: ${reason}`);
    }
    if (response.body === "") return {};
    try {
      return JSON.parse(response.body);
    } catch {
      return response.body;
    }
  }

  private index(name: string): string {
    return encodeURIComponent(name);
  }

  async ping() {
    const info = (await this.call("GET", "/")) as { version?: { number?: string; distribution?: string }; tagline?: string };
    return { serverVersion: `${info.version?.distribution === "opensearch" ? "OpenSearch" : "Elasticsearch"} ${info.version?.number ?? "unknown"}` };
  }

  async listDatabases() {
    return [];
  }

  async listSchemas() {
    return [];
  }

  async listObjects(_scope: Scope, options: { pattern: string; cursor: string | null }): Promise<ObjectPage> {
    const list = (await this.call("GET", "/_cat/indices?format=json&h=index,docs.count&expand_wildcards=open")) as { index: string }[];
    const needle = options.pattern.toLowerCase();
    return {
      objects: list
        .map((item) => item.index)
        .filter((name) => !name.startsWith(".") && (!needle || name.toLowerCase().includes(needle)))
        .sort()
        .map((name) => ({ name, kind: "index" })),
      nextCursor: null,
    };
  }

  private async mappingColumns(name: string): Promise<{ name: string; type: string | null }[]> {
    const mapping = (await this.call("GET", `/${this.index(name)}/_mapping`)) as Record<string, { mappings?: { properties?: Record<string, { type?: string }> } }>;
    const columns = new Map<string, string | null>();
    for (const index of Object.values(mapping)) {
      for (const [field, info] of Object.entries(index.mappings?.properties ?? {})) columns.set(field, info.type ?? "object");
    }
    return [...columns.entries()].map(([field, type]) => ({ name: field, type }));
  }

  async describe(ref: ObjectRef): Promise<ObjectDetails> {
    const fields = await this.mappingColumns(ref.name);
    const count = (await this.call("GET", `/${this.index(ref.name)}/_count`)) as { count?: number };
    const settings = (await this.call("GET", `/${this.index(ref.name)}`)) as unknown;
    return {
      name: ref.name,
      kind: "index",
      columns: [{ name: ID_COLUMN, type: "keyword", nullable: false, defaultValue: null, isKey: true, generated: true }, ...fields.map((field) => ({ name: field.name, type: field.type, nullable: true, defaultValue: null, isKey: false, generated: false }))],
      keyColumns: [ID_COLUMN],
      keyReason: null,
      indexes: [],
      foreignKeys: [],
      definition: JSON.stringify(settings, null, 2),
      facts: [{ label: "Documents", value: String(count.count ?? "unknown") }],
    };
  }

  private compile(filters: Filter[]): unknown {
    const must: unknown[] = [];
    const mustNot: unknown[] = [];
    for (const item of filters) {
      const pattern = item.value.replace(/[\\*?]/g, (match) => `\\${match}`);
      const parsed = item.value;
      switch (item.op) {
        case "eq":
          must.push({ term: item.column === ID_COLUMN ? { _id: parsed } : { [item.column]: parsed } });
          break;
        case "ne":
          mustNot.push({ term: { [item.column]: parsed } });
          break;
        case "gt":
        case "gte":
        case "lt":
        case "lte":
          must.push({ range: { [item.column]: { [item.op]: parsed } } });
          break;
        case "contains":
          must.push({ wildcard: { [item.column]: { value: `*${pattern}*`, case_insensitive: true } } });
          break;
        case "starts":
          must.push({ prefix: { [item.column]: parsed } });
          break;
        case "null":
          mustNot.push({ exists: { field: item.column } });
          break;
        case "notnull":
          must.push({ exists: { field: item.column } });
          break;
      }
    }
    return must.length === 0 && mustNot.length === 0 ? { match_all: {} } : { bool: { must, must_not: mustNot } };
  }

  private sortClause(sort: Sort | null): unknown {
    return sort ? [{ [sort.column]: sort.descending ? "desc" : "asc" }] : undefined;
  }

  private hitsToRows(hits: { _id: string; _source?: Record<string, unknown> }[], known: string[]) {
    const names = new Map<string, null>([[ID_COLUMN, null]]);
    for (const name of known) names.set(name, null);
    const flat = hits.map((hit) => ({ [ID_COLUMN]: hit._id, ...flatten(hit._source ?? {}) }));
    for (const row of flat) for (const name of Object.keys(row)) names.set(name, null);
    const list = [...names.keys()];
    return { list, rows: flat.map((row) => list.map((name) => (row as Record<string, unknown>)[name] ?? null)) };
  }

  async read(ref: ObjectRef, query: ReadQuery): Promise<RowPage> {
    const from = query.cursor === null ? 0 : Number(query.cursor);
    if (!Number.isSafeInteger(from) || from < 0) throw new Error("Invalid page position.");
    const known = (await this.mappingColumns(ref.name)).map((field) => field.name);
    const response = (await this.call("POST", `/${this.index(ref.name)}/_search`, { from, size: query.limit + 1, query: this.compile(query.filters), sort: this.sortClause(query.sort) })) as { hits: { hits: { _id: string; _source?: Record<string, unknown> }[] } };
    const hits = response.hits.hits;
    const { list, rows } = this.hitsToRows(hits.slice(0, query.limit), known);
    const finished = finishRows(rows);
    return {
      columns: list.map((name) => ({ name, type: null, nullable: true, defaultValue: null, isKey: name === ID_COLUMN, generated: name === ID_COLUMN })),
      keyColumns: [ID_COLUMN],
      keyReason: null,
      rows: finished.rows,
      cutCells: finished.cutCells,
      truncated: finished.rows.length < rows.length,
      nextCursor: hits.length > query.limit || finished.rows.length < rows.length ? String(from + finished.rows.length) : null,
    };
  }

  async count(ref: ObjectRef, filters: Filter[]): Promise<number> {
    const response = (await this.call("POST", `/${this.index(ref.name)}/_count`, { query: this.compile(filters) })) as { count: number };
    return response.count;
  }

  async readRow(ref: ObjectRef, key: RowKey): Promise<RowPage> {
    const id = String(key[ID_COLUMN] ?? "");
    const hit = (await this.call("GET", `/${this.index(ref.name)}/_doc/${encodeURIComponent(id)}`)) as { _id: string; _source?: Record<string, unknown> };
    const { list, rows } = this.hitsToRows([hit], []);
    const finished = finishRows(rows, null, Number.MAX_SAFE_INTEGER);
    return { columns: list.map((name) => ({ name, type: null, nullable: true, defaultValue: null, isKey: name === ID_COLUMN, generated: name === ID_COLUMN })), keyColumns: [ID_COLUMN], keyReason: null, rows: finished.rows, cutCells: [], truncated: false, nextCursor: null };
  }

  async planWrite(ref: ObjectRef, op: WriteOp): Promise<WritePlan> {
    const base = `/${this.index(ref.name)}`;
    if (op.kind === "insert") {
      const { [ID_COLUMN]: id, ...document } = op.values;
      const path = id ? `${base}/_create/${encodeURIComponent(String(id))}?refresh=true` : `${base}/_doc?refresh=true`;
      return {
        preview: `${id ? "PUT" : "POST"} ${path}\n${JSON.stringify(document)}`,
        run: async () => {
          await this.call(id ? "PUT" : "POST", path, document);
          return 1;
        },
      };
    }
    if (op.kind === "update") {
      if (ID_COLUMN in op.changes) throw new Error("A document's _id cannot be changed.");
      const id = op.key[ID_COLUMN];
      if (!id) throw new Error("A document is identified by its _id.");
      const path = `${base}/_update/${encodeURIComponent(String(id))}?refresh=true`;
      return {
        preview: `POST ${path}\nSET ${JSON.stringify(op.changes)}`,
        run: async () => {
          // A script, because the partial "doc" form merges objects: a key the user removed would stay
          // while the form reported it saved.
          await this.call("POST", path, { script: { lang: "painless", source: "for (e in params.changes.entrySet()) { ctx._source[e.getKey()] = e.getValue() }", params: { changes: op.changes } } });
          return 1;
        },
      };
    }
    const ids = op.keys.map((key) => String(key[ID_COLUMN] ?? ""));
    if (ids.some((id) => id === "")) throw new Error("A document is identified by its _id.");
    const shown = ids.slice(0, 20).map((id) => `DELETE ${base}/_doc/${id}`);
    if (ids.length > 20) shown.push(`...and ${ids.length - 20} more`);
    return {
      preview: shown.join("\n"),
      run: async () => {
        const body = `${ids.map((id) => JSON.stringify({ delete: { _index: ref.name, _id: id } })).join("\n")}\n`;
        const response = (await this.call("POST", "/_bulk?refresh=true", body, { contentType: "application/x-ndjson" })) as { items: { delete?: { status: number } }[] };
        return response.items.filter((item) => item.delete?.status === 200).length;
      },
    };
  }

  async planDestroy(ref: ObjectRef, action: "drop" | "truncate"): Promise<WritePlan> {
    if (action === "truncate") throw new Error("Delete the index and create it again; Elasticsearch has no truncate.");
    const path = `/${this.index(ref.name)}`;
    return {
      preview: `DELETE ${path}`,
      run: async () => {
        await this.call("DELETE", path);
        return 0;
      },
    };
  }

  async parse(text: string): Promise<ParsedStatement[]> {
    return splitConsole(text).map((request) => ({ text: request.raw, class: classifyRequest(request.method, request.path) }));
  }

  async run(statements: ParsedStatement[], context: RunContext): Promise<QueryResult[]> {
    const results: QueryResult[] = [];
    for (const statement of statements) {
      if (context.signal.aborted) throw new PartialRunError("Cancelled.", results);
      const started = Date.now();
      try {
        const [request] = splitConsole(statement.text);
        if (!request) continue;
        const bulk = /\/_bulk\b|\/_msearch\b/.test(request.path);
        const body = bulk && request.body ? `${request.body}\n` : request.body;
        const response = await this.call(request.method, request.path, body, { signal: context.signal, timeoutMs: context.timeoutMs, contentType: bulk ? "application/x-ndjson" : "application/json" });
        results.push(this.responseToResult(statement.text, response, Date.now() - started, context.limit));
      } catch (error) {
        throw new PartialRunError(errorMessage(error), results);
      }
    }
    return results;
  }

  private responseToResult(statement: string, response: unknown, durationMs: number, limit: number): QueryResult {
    const hits = (response as { hits?: { hits?: { _id: string; _source?: Record<string, unknown> }[] } }).hits?.hits;
    const blank = { nullable: null, defaultValue: null, isKey: false, generated: false, type: null };
    if (hits) {
      const { list, rows } = this.hitsToRows(hits, []);
      const finished = finishRows(rows, limit);
      return { statement, columns: list.map((name) => ({ ...blank, name })), rows: finished.rows, cutCells: finished.cutCells, truncated: finished.truncated, affected: null, durationMs, message: null };
    }
    if (Array.isArray(response) && response.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      const names = [...new Set(response.flatMap((item) => Object.keys(item as object)))];
      const finished = finishRows(response.map((item) => names.map((name) => (item as Record<string, unknown>)[name] ?? null)), limit);
      return { statement, columns: names.map((name) => ({ ...blank, name })), rows: finished.rows, cutCells: finished.cutCells, truncated: finished.truncated, affected: null, durationMs, message: null };
    }
    const finished = finishRows([[response]]);
    return { statement, columns: [{ ...blank, name: "response" }], rows: finished.rows, cutCells: finished.cutCells, truncated: false, affected: null, durationMs, message: null };
  }

  async stream(source: StreamSource, signal: AbortSignal, onBatch: (batch: StreamBatch) => Promise<boolean>): Promise<void> {
    let index: string;
    let queryBody: Record<string, unknown>;
    if (source.kind === "object") {
      index = source.ref.name;
      queryBody = { query: this.compile(source.filters), sort: this.sortClause(source.sort) };
    } else {
      const [request, ...rest] = splitConsole(source.text);
      if (!request || rest.length > 0 || classifyRequest(request.method, request.path) !== "read") throw new Error("Export runs one read request.");
      const match = /^\/([^/?]+)\/_search/.exec(request.path);
      if (!match?.[1]) throw new Error("Export runs a search on one index, like GET /my-index/_search.");
      index = decodeURIComponent(match[1]);
      queryBody = request.body ? (JSON.parse(request.body) as Record<string, unknown>) : {};
    }
    // search_after with _doc stays stable past the 10,000 hit limit on from and size. Sorting on _id
    // needs field data, so a point in time is used when the server has one.
    const known = (await this.mappingColumns(index)).map((field) => field.name);
    const baseSort = Array.isArray(queryBody.sort) ? queryBody.sort : [];
    const pit = (await this.call("POST", `/${this.index(index)}/_pit?keep_alive=2m`).catch(() => null)) as { id?: string } | null;
    const pitId = pit?.id;
    let after: unknown[] | undefined;
    let from = 0;
    try {
      for (;;) {
        if (signal.aborted) throw new Error("Cancelled.");
        const body: Record<string, unknown> = { ...queryBody, size: STREAM_BATCH };
        const response = pitId
          ? ((await this.call("POST", "/_search", { ...body, sort: [...baseSort, { _shard_doc: "asc" }], pit: { id: pitId, keep_alive: "2m" }, ...(after ? { search_after: after } : {}) }, { signal })) as { hits: { hits: { _id: string; _source?: Record<string, unknown>; sort?: unknown[] }[] } })
          : ((await this.call("POST", `/${this.index(index)}/_search`, { ...body, from }, { signal })) as { hits: { hits: { _id: string; _source?: Record<string, unknown>; sort?: unknown[] }[] } });
        const hits = response.hits.hits;
        if (hits.length === 0) return;
        const { list, rows } = this.hitsToRows(hits, known);
        const blank = { type: null, nullable: null, defaultValue: null, isKey: false, generated: false };
        if (!(await onBatch({ columns: list.map((name) => ({ ...blank, name })), rows }))) return;
        if (hits.length < STREAM_BATCH) return;
        after = hits[hits.length - 1]?.sort;
        from += hits.length;
      }
    } finally {
      if (pitId) await this.call("DELETE", "/_pit", { id: pitId }).catch(() => undefined);
    }
  }

  async importInto(ref: ObjectRef, columns: string[], produce: (insert: (rows: unknown[][]) => Promise<void>) => Promise<void>): Promise<void> {
    await produce(async (rows) => {
      if (rows.length === 0) return;
      const lines: string[] = [];
      for (const row of rows) {
        const document: Record<string, unknown> = {};
        let id: unknown;
        for (const [index, name] of columns.entries()) {
          if (name === ID_COLUMN) id = row[index];
          else document[name] = row[index];
        }
        lines.push(JSON.stringify({ index: { _index: ref.name, ...(id ? { _id: String(id) } : {}) } }), JSON.stringify(document));
      }
      const response = (await this.call("POST", "/_bulk?refresh=wait_for", `${lines.join("\n")}\n`, { contentType: "application/x-ndjson" })) as { errors: boolean; items: { index?: { error?: { reason?: string } } }[] };
      if (response.errors) throw new Error(response.items.find((item) => item.index?.error)?.index?.error?.reason ?? "Some documents were refused.");
    });
  }

  async close() {
    return;
  }
}

export async function createElasticsearch(context: AdapterContext): Promise<Adapter> {
  return new ElasticAdapter(context);
}
