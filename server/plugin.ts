import { link, mkdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { inferValue } from "../shared/values";
import { open as openFile } from "node:fs/promises";
import { type ExportFormat, type ExportSource, type JobView, type ObjectRef, type QueryResult, queryTabs, rpc, type SavedView, savedPlace, savedView, type Scope, searchStructure, type StartResult } from "../shared/contracts";
import { ENGINES } from "../shared/engines";
import type { Adapter, StreamSource, WritePlan } from "./adapters/types";
import { createDescribeTool, agentMayRead } from "./agent-tool";
import { dataFolder } from "./paseo-home";
import { errorMessage, guard } from "./errors";
import { exporterFor, openOutput, readRecords, sqlTextFor, writeChunk } from "./formats";
import { type JobOutcome, Jobs } from "./jobs";
import { Pool } from "./pool";
import { PreferencesReader, preferencesDocument } from "./preferences";
import { SideFile } from "./side-file";
import { structureOf, structureText } from "./structure";
import { checkDestroyName, gate } from "./safety";
import { Store, toView } from "./store";
import { z } from "zod";

// Under the daemon's 30 second limit on any RPC, so the user sees this message rather than a timeout.
const READ_DEADLINE_MS = 25000;
const TEXT_EXPORT_LIMIT = 5 * 1024 * 1024;
const PREVIEW_RECORDS = 20;

function withDeadline<T>(work: Promise<T>): Promise<T> {
  return withStartDeadline(() => work);
}

// For a request that ends by starting a job. If the deadline passed while it was preparing, the user has
// already been told it failed, so it must not then start: a retry would run the statement twice. The
// handler calls stillWanted right before it starts the job.
function withStartDeadline<T>(prepare: (stillWanted: () => void) => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  let expired = false;
  const message = `This took longer than ${READ_DEADLINE_MS / 1000} seconds, and nothing was started. Try a narrower filter, or use the query box, which has a longer limit.`;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error(message));
    }, READ_DEADLINE_MS);
  });
  const stillWanted = () => {
    if (expired) throw new Error(message);
  };
  return Promise.race([prepare(stillWanted), deadline]).finally(() => clearTimeout(timer));
}

function expandPath(path: string): string {
  const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  if (!isAbsolute(expanded)) throw new Error("Give a full path, starting with / or ~/.");
  return expanded;
}

function toStreamSource(source: ExportSource): StreamSource {
  return source.kind === "object" ? { kind: "object", ref: source.ref, sort: source.sort, filters: source.filters } : { kind: "query", scope: source.scope, text: source.text };
}

function sourceConnection(source: ExportSource): string {
  return source.kind === "object" ? source.ref.connectionId : source.scope.connectionId;
}

function sourceName(source: ExportSource): string {
  return source.kind === "object" ? source.ref.name : "query_result";
}

// folder is for the test bed, which has no Paseo daemon to ask.
const onStray = (error: unknown) => console.error("Datawise: stray driver error:", errorMessage(error));

const ATTACHMENT_MATCHES = 10;
const EMPTY_VIEW: SavedView = { hiddenColumns: [], columnOrder: [], sort: null, filtersInUse: [], filters: [] };

function viewKey(ref: ObjectRef): string {
  return JSON.stringify([ref.connectionId, ref.database ?? null, ref.schema ?? null, ref.name]);
}

export function contributeServer(server: Pick<PluginServerContext, "handle" | "registerSettings" | "addHook">, folder?: string) {
  const findFolder = folder ? () => Promise.resolve(folder) : dataFolder;
  const store = new Store(findFolder);
  const pool = new Pool(store);
  const jobs = new Jobs();
  const views = new SideFile(findFolder, "views.json", z.object({ views: z.record(z.string(), savedView) }), () => ({ views: {} }));
  const workspace = new SideFile(findFolder, "workspace.json", z.object({ places: z.record(z.string(), savedPlace), tabs: z.record(z.string(), queryTabs) }), () => ({ places: {}, tabs: {} }));
  const preferences = new PreferencesReader(server.registerSettings(preferencesDocument) as never, (values) => {
    pool.setIdleCloseMinutes(values.idleCloseMinutes);
    void store.trimHistory(values.historyLength).catch((error: unknown) => onStray(error));
  });
  void preferences.get().then((values) => pool.setIdleCloseMinutes(values.idleCloseMinutes));

  // Declaring this hook makes every open agent session reopen, even if the handler changes nothing, so it
  // exists only while a connection is shared. The handler does no work, because one that throws would stop
  // every agent on the daemon from opening a session.
  // A save still on its way when a connection is deleted must not bring back what the delete removed.
  const connectionExists = async (id: string) => (await store.listConnections()).some((item) => item.id === id);

  const describeTool = createDescribeTool(store, pool);
  let removeAgentHook: (() => void) | null = null;
  const syncAgentHook = async () => {
    const wanted = (await store.listConnections()).some(agentMayRead);
    if (wanted && !removeAgentHook) removeAgentHook = server.addHook("agent.open.before", async ({ request }) => ({ ...request, tools: [...request.tools, describeTool] }));
    if (!wanted && removeAgentHook) {
      removeAgentHook();
      removeAgentHook = null;
    }
  };

  // Sockets die, and a driver event with no listener would otherwise end this process and every job in
  // it. Log it, without details that could hold a secret, and let the pool rebuild on the next request.
  process.on("uncaughtException", onStray);
  process.on("unhandledRejection", onStray);
  void syncAgentHook().catch(onStray);

  const startBatch = async (ref: ObjectRef, input: RpcInput<typeof rpc.writeBatch>, stillWanted: () => void): Promise<StartResult> =>
    pool.use(ref.connectionId, async (adapter, connection) => {
      if (!ENGINES[connection.engine].transactionalEdits || !adapter.planBatch) throw new Error(`${ENGINES[connection.engine].label} cannot commit several edits as one.`);
      gate({ mode: connection.safety === "read-only" ? "read-only" : "open", writes: true, confirmed: true, preview: `Write to ${ref.name}` });
      const plan = await adapter.planBatch(ref, input.edits);
      if (input.dryRun) return { status: "confirm" as const, preview: plan.preview, reason: `${input.edits.length} edit${input.edits.length === 1 ? "" : "s"}, committed together or not at all.` };
      return startPlan(ref.connectionId, plan, input.confirmed, connection.safety, stillWanted);
    });

  const startPlan = (connectionId: string, plan: WritePlan, confirmed: boolean, mode: Parameters<typeof gate>[0]["mode"], stillWanted: () => void): StartResult => {
    const answer = gate({ mode, writes: true, confirmed, preview: plan.preview });
    if (answer.kind === "confirm") return { status: "confirm", preview: answer.preview, reason: answer.reason };
    stillWanted();
    const job = jobs.start("write", null, async () => ({ affected: await pool.use(connectionId, () => plan.run()) }));
    return { status: "started", job };
  };

  server.handle(rpc.listConnections, guard(async () => ({ connections: (await store.listConnections()).map(toView) })));
  server.handle(
    rpc.saveConnection,
    guard(async (input: RpcInput<typeof rpc.saveConnection>) => {
      const saved = await store.saveConnection(input);
      // The next request connects with the new settings.
      await pool.disconnect(saved.id);
      await syncAgentHook();
      return toView(saved);
    }),
  );
  server.handle(
    rpc.deleteConnection,
    guard(async ({ id }: { id: string }) => {
      await pool.disconnect(id);
      await store.deleteConnection(id);
      await syncAgentHook();
      const prefix = JSON.stringify([id]).slice(0, -1);
      await views.update((state) => {
        for (const key of Object.keys(state.views)) if (key.startsWith(prefix)) delete state.views[key];
      });
      await workspace.update((state) => {
        delete state.tabs[id];
        for (const [surface, place] of Object.entries(state.places)) if (place.connectionId === id) delete state.places[surface];
      });
      return { ok: true as const };
    }),
  );
  server.handle(
    rpc.testConnection,
    guard(async (input: RpcInput<typeof rpc.testConnection>) => {
      try {
        const connection = await store.resolveInput(input);
        const result = await withDeadline(pool.test(connection));
        return { ok: true, serverVersion: result.serverVersion, latencyMs: result.latencyMs, error: null, sshHostFingerprint: result.fingerprint };
      } catch (error) {
        return { ok: false, serverVersion: null, latencyMs: null, error: errorMessage(error), sshHostFingerprint: null };
      }
    }),
  );
  server.handle(
    rpc.disconnect,
    guard(async ({ id }: { id: string }) => {
      await pool.disconnect(id);
      return { ok: true as const };
    }),
  );
  server.handle(rpc.unlockConnection, guard(async ({ id, password }: { id: string; password: string }) => toView(await store.unlock(id, password))));
  server.handle(
    rpc.clearSshFingerprint,
    guard(async ({ id }: { id: string }) => {
      await pool.disconnect(id);
      return toView(await store.setSshFingerprint(id, null));
    }),
  );

  server.handle(rpc.listDatabases, guard(async ({ connectionId }: { connectionId: string }) => ({ databases: await withDeadline(pool.use(connectionId, (adapter) => adapter.listDatabases())) })));
  server.handle(rpc.listSchemas, guard(async (scope: Scope) => ({ schemas: await withDeadline(pool.use(scope.connectionId, (adapter) => adapter.listSchemas(scope))) })));
  server.handle(rpc.listObjects, guard(async (input: RpcInput<typeof rpc.listObjects>) => withDeadline(pool.use(input.connectionId, (adapter) => adapter.listObjects(input, { pattern: input.pattern, cursor: input.cursor })))));
  server.handle(rpc.describeObject, guard(async (ref: ObjectRef) => withDeadline(pool.use(ref.connectionId, (adapter) => adapter.describe(ref)))));
  server.handle(rpc.readRows, guard(async ({ ref, query }: RpcInput<typeof rpc.readRows>) => withDeadline(pool.use(ref.connectionId, (adapter) => adapter.read(ref, query)))));
  server.handle(rpc.readRow, guard(async ({ ref, key }: RpcInput<typeof rpc.readRow>) => withDeadline(pool.use(ref.connectionId, (adapter) => adapter.readRow(ref, key)))));
  server.handle(rpc.countRows, guard(async ({ ref, filters }: RpcInput<typeof rpc.countRows>) => jobs.start("count", null, async () => ({ count: await pool.use(ref.connectionId, (adapter) => adapter.count(ref, filters)) }))));

  server.handle(
    rpc.writeRows,
    guard(async ({ ref, op, confirmed }: RpcInput<typeof rpc.writeRows>) =>
      withStartDeadline((stillWanted) =>
        pool.use(ref.connectionId, async (adapter, connection) => {
          gate({ mode: connection.safety === "read-only" ? "read-only" : "open", writes: true, confirmed: true, preview: `Write to ${ref.name}` });
          return startPlan(ref.connectionId, await adapter.planWrite(ref, op), confirmed, connection.safety, stillWanted);
        }),
      ),
    ),
  );
  server.handle(rpc.writeBatch, guard(async (input: RpcInput<typeof rpc.writeBatch>) => withStartDeadline((stillWanted) => startBatch(input.ref, input, stillWanted))));
  server.handle(rpc.getView, guard(async (ref: ObjectRef) => (await views.read()).views[viewKey(ref)] ?? EMPTY_VIEW));
  server.handle(
    rpc.saveView,
    guard(async ({ ref, view }: RpcInput<typeof rpc.saveView>) => {
      if (!(await connectionExists(ref.connectionId))) return { ok: true as const };
      await views.update((state) => {
        state.views[viewKey(ref)] = view;
      });
      return { ok: true as const };
    }),
  );
  server.handle(rpc.getPlace, guard(async ({ surface }: { surface: string }) => ({ place: (await workspace.read()).places[surface] ?? null })));
  server.handle(
    rpc.savePlace,
    guard(async ({ surface, place }: RpcInput<typeof rpc.savePlace>) => {
      if (place && !(await connectionExists(place.connectionId))) return { ok: true as const };
      await workspace.update((state) => {
        if (place) state.places[surface] = place;
        else delete state.places[surface];
      });
      return { ok: true as const };
    }),
  );
  server.handle(rpc.getQueryTabs, guard(async ({ connectionId }: { connectionId: string }) => ({ tabs: (await workspace.read()).tabs[connectionId] ?? null })));
  server.handle(
    rpc.saveQueryTabs,
    guard(async ({ connectionId, tabs }: RpcInput<typeof rpc.saveQueryTabs>) => {
      if (!(await connectionExists(connectionId))) return { ok: true as const };
      // With drafts off, tab names stay and the text does not reach the disk.
      const { keepDrafts } = await preferences.get();
      await workspace.update((state) => {
        state.tabs[connectionId] = keepDrafts ? tabs : { ...tabs, tabs: tabs.tabs.map((tab) => ({ ...tab, text: "" })) };
      });
      return { ok: true as const };
    }),
  );
  server.handle(
    rpc.inspectSqlite,
    guard(async ({ path }: { path: string }) => {
      const handle = await openFile(path, "r");
      try {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(100), 0, 100, 0);
        const isSqlite = bytesRead >= 100 && buffer.subarray(0, 16).toString("latin1") === "SQLite format 3\0";
        // Bytes 18 and 19 hold the write and read versions, and 2 means write-ahead logging.
        return { isSqlite, wal: isSqlite && (buffer[18] === 2 || buffer[19] === 2) };
      } finally {
        await handle.close();
      }
    }),
  );
  server.handle(
    searchStructure,
    guard(async ({ query }: { query: string }) =>
      withDeadline(
        (async () => {
          const needle = query.trim();
          const items: { id: string; identifier: string; title: string; subtitle: string; url: string; text: string; resourceType: string }[] = [];
          if (needle === "") return { items };
          // Only connections already open, so a search can never start one, ask for a password, or reach
          // a server nobody is using. Production stays out, as with agent access.
          const usable = (await store.listConnections()).filter((item) => pool.isOpen(item.id) && item.environment !== "production" && ENGINES[item.engine].catalogSchema);
          for (const connection of usable) {
            if (items.length >= ATTACHMENT_MATCHES) break;
            // One server failing must not empty the picker for the rest.
            await pool.use(connection.id, async (adapter) => {
              const info = ENGINES[connection.engine];
              const database = info.databaseLabel ? connection.database || (await adapter.listDatabases())[0] : undefined;
              const schema = info.schemaLabel ? (await adapter.listSchemas({ connectionId: connection.id, database }))[0] : undefined;
              const scope = { connectionId: connection.id, database, schema };
              const { objects } = await adapter.listObjects(scope, { pattern: needle, cursor: null });
              for (const object of objects.slice(0, ATTACHMENT_MATCHES - items.length)) {
                const details = await adapter.describe({ ...scope, name: object.name });
                const place = [database, schema, object.name].filter(Boolean).join(".");
                items.push({ id: `${connection.id}:${place}`, identifier: connection.name, title: place, subtitle: `${info.label}. Goes to the agent's provider.`, url: `datawise://structure/${encodeURIComponent(connection.id)}/${encodeURIComponent(place)}`, text: `Table structure from ${connection.name}:\n${structureText(structureOf(details))}`, resourceType: object.kind });
              }
            }).catch((error: unknown) => console.error("Datawise: attachment search failed for one connection:", errorMessage(error)));
          }
          return { items };
        })(),
      ),
    ),
  );
  server.handle(
    rpc.destroyObject,
    guard(async ({ ref, action, confirmName }: RpcInput<typeof rpc.destroyObject>) => {
      checkDestroyName(ref.name, confirmName);
      return withStartDeadline((stillWanted) =>
        pool.use(ref.connectionId, async (adapter, connection) => {
          const plan = await adapter.planDestroy(ref, action);
          // The typed name is the confirmation; there is no second prompt on top of it.
          return startPlan(ref.connectionId, plan, true, connection.safety, stillWanted);
        }),
      );
    }),
  );

  server.handle(
    rpc.runQuery,
    guard(async (input: RpcInput<typeof rpc.runQuery>) =>
      withStartDeadline((stillWanted) =>
        pool.use(input.scope.connectionId, async (adapter, connection) => {
          const given = await adapter.parse(input.text);
          if (given.length === 0) throw new Error("There is no statement to run.");
          let statements = given;
          if (input.explain) {
            // Decided here, not by adding text in the client: "SELECT 1; DELETE FROM t" with a prefix in
            // front explains the first statement and really runs the second.
            const prefix = ENGINES[connection.engine].explainPrefix;
            const only = given[0];
            if (!prefix) throw new Error(`${ENGINES[connection.engine].label} has no explain here.`);
            if (given.length !== 1 || !only) throw new Error("Explain takes one statement.");
            statements = await adapter.parse(`${prefix}${only.text}`);
          }
          const writing = statements.filter((statement) => statement.class !== "read");
          const answer = gate({
            mode: connection.safety,
            writes: writing.length > 0,
            confirmed: input.confirmed,
            preview: writing.map((statement) => statement.text).join("\n"),
            reason: writing.every((statement) => statement.class === "write") ? "This can change data." : "Datawise could not tell whether this changes data.",
          });
          if (answer.kind === "confirm") return { status: "confirm" as const, preview: answer.preview, reason: answer.reason };
          stillWanted();
          const job = jobs.start("query", null, async ({ signal }): Promise<JobOutcome> => {
            const started = Date.now();
            const combined = AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs)]);
            const finish = async (ok: boolean) => {
              const { keepHistory, historyLength } = await preferences.get();
              if (keepHistory) await store.addHistory(connection.id, { text: input.text, durationMs: Date.now() - started, ok }, historyLength).catch(() => undefined);
            };
            try {
              const results: QueryResult[] = await pool.use(connection.id, (live) => live.run(statements, { scope: input.scope, limit: input.limit, timeoutMs: input.timeoutMs, signal: combined, readOnly: connection.safety === "read-only" }));
              await finish(true);
              return { results };
            } catch (error) {
              await finish(false);
              throw error;
            }
          });
          return { status: "started" as const, job };
        }),
      ),
    ),
  );

  server.handle(rpc.listHistory, guard(async ({ connectionId }: { connectionId: string }) => ({ entries: await store.listHistory(connectionId) })));
  server.handle(
    rpc.clearHistory,
    guard(async ({ connectionId }: { connectionId: string }) => {
      await store.clearHistory(connectionId);
      return { ok: true as const };
    }),
  );
  server.handle(rpc.listSaved, guard(async ({ connectionId }: { connectionId: string }) => ({ queries: await store.listSaved(connectionId) })));
  server.handle(rpc.saveQuery, guard(async ({ connectionId, ...query }: RpcInput<typeof rpc.saveQuery>) => store.saveQuery(connectionId, query)));
  server.handle(
    rpc.deleteSaved,
    guard(async ({ connectionId, id }: { connectionId: string; id: string }) => {
      await store.deleteSaved(connectionId, id);
      return { ok: true as const };
    }),
  );

  server.handle(
    rpc.importPreview,
    guard(async ({ source, format }: RpcInput<typeof rpc.importPreview>) =>
      withDeadline(
        (async () => {
          const rows: Record<string, unknown>[] = [];
          const columns = new Map<string, null>();
          const resolved = "path" in source ? { path: expandPath(source.path) } : source;
          for await (const record of readRecords(resolved, format)) {
            rows.push(record);
            for (const name of Object.keys(record)) columns.set(name, null);
            if (rows.length >= PREVIEW_RECORDS) break;
          }
          return { columns: [...columns.keys()], rows };
        })(),
      ),
    ),
  );

  server.handle(
    rpc.startImport,
    guard(async ({ ref, source, options, confirmed }: RpcInput<typeof rpc.startImport>) => {
      const connection = await store.getConnection(ref.connectionId);
      const targets = Object.keys(options.mapping);
      if (targets.length === 0) throw new Error("Map at least one column.");
      const answer = gate({ mode: connection.safety, writes: true, confirmed, preview: `Import into ${ref.name}: ${targets.join(", ")}` });
      if (answer.kind === "confirm") return { status: "confirm" as const, preview: answer.preview, reason: answer.reason };
      const resolved = "path" in source ? { path: expandPath(source.path) } : source;
      const fromText = options.format === "csv" || options.format === "tsv";
      const infer = fromText && ENGINES[connection.engine].schemaless;
      const convert = (value: unknown): unknown => {
        if (value === undefined) return null;
        if (!fromText || typeof value !== "string") return value;
        if (value === "" && options.emptyIsNull) return null;
        return infer ? inferValue(value) : value;
      };
      const job = jobs.start("import", null, async ({ signal, setRows }): Promise<JobOutcome> => {
        let done = 0;
        try {
          await pool.use(ref.connectionId, (adapter) =>
            adapter.importInto(ref, targets, async (insert) => {
              let batch: unknown[][] = [];
              for await (const record of readRecords(resolved, options.format)) {
                if (signal.aborted) throw new Error("Cancelled.");
                batch.push(targets.map((target) => convert(record[options.mapping[target] ?? ""])));
                if (batch.length >= options.batchSize) {
                  await insert(batch);
                  done += batch.length;
                  setRows(done);
                  batch = [];
                }
              }
              if (batch.length > 0) {
                await insert(batch);
                done += batch.length;
                setRows(done);
              }
            }),
          );
        } catch (error) {
          // With a transaction nothing landed. Without one, say how much did, so nothing is imported twice.
          const landed = ENGINES[connection.engine].transactionalImport ? "No rows were kept." : `${done} rows were already written and stay in place.`;
          throw new Error(`${errorMessage(error)} ${landed}`);
        }
        return { message: `Imported ${done} rows.` };
      });
      return { status: "started" as const, job };
    }),
  );

  const runExportBody = async (source: ExportSource, format: ExportFormat, signal: AbortSignal, onChunk: (text: string, rows: number) => Promise<boolean>): Promise<{ rows: number; dropped: string[] }> => {
    const connection = await store.getConnection(sourceConnection(source));
    if (format === "sql" && !ENGINES[connection.engine].exportSqlInserts) throw new Error(`${ENGINES[connection.engine].label} has no SQL inserts to export. Use another format.`);
    const exporter = exporterFor(format, sourceName(source), sqlTextFor(connection.engine));
    const fixedColumns = format === "csv" || format === "tsv";
    let header: string[] | null = null;
    let rows = 0;
    const dropped = new Set<string>();
    await pool.use(connection.id, (adapter: Adapter) =>
      adapter.stream(toStreamSource(source), signal, async (batch) => {
        const names = batch.columns.map((column) => column.name);
        let chunk = "";
        if (header === null) {
          header = names;
          chunk += exporter.header(names);
        }
        const fixed: string[] = header;
        let shown = batch.rows;
        // A schemaless source can show new fields after the header is written. CSV cannot add a column,
        // so those are reported instead of being lost without a word.
        if (fixedColumns) {
          for (const name of names) if (!fixed.includes(name)) dropped.add(name);
          shown = batch.rows.map((row) => fixed.map((name) => row[names.indexOf(name)] ?? null));
        }
        chunk += exporter.rows(fixedColumns ? fixed : names, shown);
        rows += batch.rows.length;
        return onChunk(chunk, rows);
      }),
    );
    if (header === null) await onChunk(exporter.header([]), 0);
    await onChunk(exporter.footer(), rows);
    return { rows, dropped: [...dropped] };
  };

  server.handle(
    rpc.startExport,
    guard(async ({ source, format, path }: RpcInput<typeof rpc.startExport>) => {
      const target = expandPath(path);
      await stat(target).then(
        () => {
          throw new Error(`${target} already exists. Choose another name.`);
        },
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
      await mkdir(dirname(target), { recursive: true });
      const job: JobView = jobs.start("export", target, async ({ signal, setRows }): Promise<JobOutcome> => {
        const partial = `${target}.partial`;
        const output = openOutput(partial);
        const opened = new Promise<void>((resolve, reject) => {
          output.once("open", () => resolve());
          output.once("error", reject);
        });
        await opened;
        try {
          const { rows, dropped } = await runExportBody(source, format, signal, async (text, count) => {
            await writeChunk(output, text);
            setRows(count);
            return true;
          });
          await new Promise<void>((resolve, reject) => output.end((error?: Error | null) => (error ? reject(error) : resolve())));
          // link fails if the name was taken meanwhile, so a finished export never replaces a file.
          await link(partial, target);
          await unlink(partial);
          return { message: `Exported ${rows} rows.${dropped.length > 0 ? ` These fields first appeared after the header was written and are not in the file: ${dropped.slice(0, 20).join(", ")}. JSON keeps them.` : ""}` };
        } catch (error) {
          output.destroy();
          await unlink(partial).catch(() => undefined);
          throw error;
        }
      });
      return { job };
    }),
  );

  server.handle(
    rpc.defaultExportPath,
    guard(async ({ name, format }: RpcInput<typeof rpc.defaultExportPath>) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const safeName = name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "export";
      const { exportFolder } = await preferences.get();
      return { path: join(exportFolder.trim() ? expandPath(exportFolder.trim()) : join(homedir(), "Downloads", "datawise"), `${safeName}-${stamp}.${format}`) };
    }),
  );

  server.handle(
    rpc.exportText,
    guard(async ({ source, format }: RpcInput<typeof rpc.exportText>) =>
      jobs.start("text", null, async ({ signal, setRows }): Promise<JobOutcome> => {
        let text = "";
        let truncated = false;
        const { rows } = await runExportBody(source, format, signal, async (chunk, count) => {
          setRows(count);
          if (text.length + chunk.length > TEXT_EXPORT_LIMIT) {
            truncated = true;
            return false;
          }
          text += chunk;
          return true;
        });
        return { text, truncated, message: `${rows} rows${truncated ? ", cut at 5 MB" : ""}.` };
      }),
    ),
  );

  server.handle(rpc.jobStatus, guard(async ({ id }: { id: string }) => jobs.status(id)));
  server.handle(
    rpc.cancelJob,
    guard(async ({ id }: { id: string }) => {
      jobs.cancel(id);
      return { ok: true as const };
    }),
  );

  return async () => {
    process.off("uncaughtException", onStray);
    process.off("unhandledRejection", onStray);
    preferences.close();
    removeAgentHook?.();
    jobs.cancelAll();
    await pool.closeAll();
  };
}
