import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { setDriverRoot } from "./drivers";
import { contributeServer } from "./plugin";

// Drivers load from this checkout's node_modules, as the conformance script does; there is no Paseo to ask.
setDriverRoot(join(__dirname, ".."));

type Tool = { name: string; input: { parse(value: unknown): unknown }; execute(input: unknown, context: unknown): Promise<{ text?: string; isError?: boolean }> };
type Handler = (input: unknown, context?: unknown) => Promise<unknown> | unknown;

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

function start() {
  const folder = mkdtempSync(join(tmpdir(), "datawise-open-"));
  const handlers = new Map<string, Handler>();
  const inputs = new Map<string, { parse(value: unknown): unknown }>();
  let hook: ((input: { request: { tools: Tool[] } }) => Promise<{ tools: Tool[] }>) | null = null;
  const cleanup = contributeServer(
    {
      handle: (contract: { name: string; input: { parse(value: unknown): unknown } }, handler: Handler) => {
        handlers.set(contract.name, handler);
        inputs.set(contract.name, contract.input);
      },
      // Exports go to this test's own folder, never the person's Downloads.
      registerSettings: (definition: { schema: { parse(value: unknown): unknown } }) => ({ read: async () => ({ status: "ready", values: definition.schema.parse({ exportFolder: join(folder, "exports") }) }), subscribe: () => () => undefined }),
      addHook: (_name: string, handler: typeof hook) => {
        hook = handler;
        return () => undefined;
      },
    } as never,
    folder,
  );
  stops.push(async () => {
    await cleanup();
    rmSync(folder, { recursive: true, force: true });
  });
  // Paseo parses every input against its contract before the handler sees it, which fills in defaults.
  const call = (name: string, input: unknown) => (handlers.get(name) as Handler)(inputs.get(name)?.parse(input));
  const pushed: unknown[] = [];
  const window = () => {
    const controller = new AbortController();
    void (handlers.get("agent.opens") as Handler)({}, { push: async (event: unknown) => void pushed.push(event), signal: controller.signal });
    return () => controller.abort();
  };
  const use = async (name: string, input: unknown, agent: Record<string, unknown> = { id: "agent-a", title: "Agent A", workspaceId: "ws-1" }) => {
    const tool = (await (hook as NonNullable<typeof hook>)({ request: { tools: [] } })).tools.find((item) => item.name === name) as Tool;
    return tool.execute(tool.input.parse(input), { agent });
  };
  const open = (input: unknown, agent?: Record<string, unknown>) => use("datawise_open", input, agent);
  return { call, use, open, window, pushed, folder };
}

const local = { engine: "sqlite", file: "/tmp/datawise-open-test.db", safety: "confirm" };

describe("open-tab", () => {
  it("refuses an agent outside a workspace", async () => {
    const { open } = start();
    const answer = await open({ connection: "anything" }, { id: "agent-a", title: null, workspaceId: null });
    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(/not in a workspace/);
  });

  it("answers the same for any unknown name", async () => {
    const { open } = start();
    expect((await open({ connection: "nope" })).text).toBe("No connection named nope.");
  });

  it("saves the place and tells every window", async () => {
    const { call, open, window, pushed } = start();
    const saved = (await call("connections.save", { name: "Dev", ...local })) as { id: string };
    window();
    window();
    const answer = await open({ connection: "Dev", table: "users", query: "select 1" });
    expect(answer.text).toBe("Asked 2 Paseo windows to show Dev in Datawise.");
    expect(pushed).toHaveLength(2);
    expect(pushed[0]).toMatchObject({ workspaceId: "ws-1", text: "select 1", production: null, place: { connectionId: saved.id, object: { name: "users" }, tab: "query" } });
    // The window saves it once it moves there, so a person who keeps their pending edits keeps their place.
    expect(((await call("workspace.place.get", { surface: "panel:ws-1" })) as { place: unknown }).place).toBeNull();
  });

  it("saves the place for next time when no window is open", async () => {
    const { call, open } = start();
    const saved = (await call("connections.save", { name: "Dev", ...local })) as { id: string };
    await open({ connection: "Dev", table: "users" });
    expect(((await call("workspace.place.get", { surface: "panel:ws-1" })) as { place: unknown }).place).toMatchObject({ connectionId: saved.id });
  });

  it("saves nothing for production and asks the person", async () => {
    const { call, open, window, pushed } = start();
    await call("connections.save", { name: "Live", ...local, environment: "production" });
    window();
    const answer = await open({ connection: "Live" });
    expect(answer.text).toMatch(/waits in this workspace's Datawise tab/);
    expect(pushed[0]).toMatchObject({ production: { agentTitle: "Agent A", connectionName: "Live" } });
    expect(((await call("workspace.place.get", { surface: "panel:ws-1" })) as { place: unknown }).place).toBeNull();
  });

  it("says when no window is open", async () => {
    const { call, open } = start();
    await call("connections.save", { name: "Dev", ...local });
    expect((await open({ connection: "Dev" })).text).toMatch(/No Paseo window is open/);
  });

  it("is limited to one request per agent every few seconds", async () => {
    const { call, open } = start();
    await call("connections.save", { name: "Dev", ...local });
    await open({ connection: "Dev" });
    expect((await open({ connection: "Dev" })).text).toMatch(/Wait a few seconds/);
  });
});

describe("query tools", () => {
  async function shared(level: "read" | "propose" | "none" = "read") {
    const harness = start();
    const file = join(harness.folder, "dev.db");
    const db = new DatabaseSync(file);
    db.exec("create table t (id integer primary key, note text); insert into t values (1, 'a')");
    db.close();
    const saved = (await harness.call("connections.save", { name: "Dev", engine: "sqlite", file, safety: "open", environment: "development", agentAccess: "schema", agentRowAccess: level })) as { id: string };
    const run = async (text: string) => {
      const started = (await harness.call("query.run", { scope: { connectionId: saved.id }, text })) as { status: string; job: { id: string } };
      for (;;) {
        const job = (await harness.call("jobs.status", { id: started.job.id })) as { status: string };
        if (job.status !== "running" && job.status !== "queued") return job;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    return { ...harness, run };
  }

  it("refuses the 61st query, count or explain an agent sends in a minute", async () => {
    const { use } = await shared();
    for (let index = 0; index < 60; index += 1) expect((await use("datawise_count", { connection: "Dev", table: "t" })).isError).toBeFalsy();
    expect((await use("datawise_query", { connection: "Dev", query: "select 1" })).text).toMatch(/60 reads, queries, counts or explains in the last minute/);
    expect((await use("datawise_count", { connection: "Dev", table: "t" }, { id: "agent-b", title: null, workspaceId: null })).isError).toBeFalsy();
  });

  it("returns at most 200 rows, and halves a result until the answer fits in 256 KiB", async () => {
    const { use } = await shared();
    const many = "with recursive c(x) as (select 1 union all select x + 1 from c where x < 500) select x";
    const parse = (text: string | undefined) => JSON.parse(String(text).slice(String(text).indexOf("{"))) as { results: { rows: unknown[]; truncated: boolean }[] };
    const small = parse((await use("datawise_query", { connection: "Dev", query: `${many} from c` })).text);
    expect(small.results[0].rows).toHaveLength(200);
    expect(small.results[0].truncated).toBe(true);
    const wide = await use("datawise_query", { connection: "Dev", query: `${many}, replace(hex(zeroblob(1500)), '0', 'w') from c` });
    expect(Buffer.byteLength(String(wide.text))).toBeLessThanOrEqual(256 * 1024 + 200);
    expect(parse(wide.text).results[0].rows.length).toBeLessThan(200);
  });

  it("lists only reads from history, so a statement that could hold a password stays out", async () => {
    const { use, run } = await shared();
    await run("select note from t where id = 1");
    await run("update t set note = 'PLANTED_SECRET' where id = 1");
    const listed = await use("datawise_history", { connection: "Dev" });
    expect(listed.text).toContain("select note from t where id = 1");
    expect(listed.text).not.toContain("PLANTED_SECRET");
  });

  it("refuses history below read level with the same answer as an unknown name", async () => {
    const { use } = await shared("none");
    expect((await use("datawise_history", { connection: "Dev" })).text).toBe("No connection named Dev allows this.");
  });

  async function proposeAndApprove(query: string) {
    const harness = await shared("propose");
    const proposed = await harness.use("datawise_propose_query", { connection: "Dev", query });
    const requestId = /Request (\S+) is waiting/.exec(String(proposed.text))?.[1] as string;
    await harness.call("agent-requests.decide", { id: requestId, approve: true });
    for (;;) {
      const status = String((await harness.use("datawise_write_status", { requestId })).text);
      if (!/waiting|running|approved/i.test(status)) return status;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("never tells the agent nothing was written after an approved statement fails", async () => {
    const status = await proposeAndApprove("insert into missing_table values (1)");
    expect(status).not.toMatch(/nothing was written/);
    expect(status).toMatch(/may have partly applied/);
  });

  it("tells the agent how many statements ran, without the database's error text", async () => {
    const status = await proposeAndApprove("update t set note = 'b' where id = 1; insert into missing_table values (1)");
    expect(status).toMatch(/1 of 2 statements ran/);
    expect(status).not.toMatch(/missing_table/);
  });

  it("counts reads toward the same limit, since a read can be a paid scan", async () => {
    const { use } = await shared();
    for (let index = 0; index < 60; index += 1) expect((await use("datawise_read", { connection: "Dev", table: "t" })).isError).toBeFalsy();
    expect((await use("datawise_read", { connection: "Dev", table: "t" })).text).toMatch(/in the last minute/);
  });

  it("records explain and history in the activity log", async () => {
    const { use, call } = await shared();
    await use("datawise_explain", { connection: "Dev", query: "select * from t" });
    await use("datawise_history", { connection: "Dev" });
    const { events } = (await call("agent-activity.list", {})) as { events: { action: string }[] };
    expect(events.filter((event) => event.action === "read")).toHaveLength(2);
  });

  it("fits history in 256 KiB however long the saved queries are", async () => {
    const { use, run } = await shared();
    const long = `select 1 -- ${"x".repeat(200 * 1024)}`;
    await run(`${long}a`);
    await run(`${long}b`);
    const listed = await use("datawise_history", { connection: "Dev" });
    expect(Buffer.byteLength(String(listed.text))).toBeLessThanOrEqual(256 * 1024 + 200);
    expect(listed.text).toContain("select 1");
  });

  it("bounds a count's names, as every new tool's inputs are", async () => {
    const { use } = await shared();
    await expect(use("datawise_count", { connection: "x".repeat(201), table: "t" })).rejects.toThrow();
    await expect(use("datawise_count", { connection: "Dev", table: "t", filters: [{ column: "note", op: "eq", value: "v".repeat(256 * 1024 + 1) }] })).rejects.toThrow();
  });

  it("refuses every data tool on a connection labelled production, even one edited by hand", async () => {
    const first = await shared("propose");
    const file = join(first.folder, "connections.json");
    const edited = readFileSync(file, "utf8").replace('"environment": "development"', '"environment": "production"');
    expect(edited).toContain('"environment": "production"');
    const second = start();
    writeFileSync(join(second.folder, "connections.json"), edited);
    const calls: [string, Record<string, unknown>][] = [["datawise_describe", {}], ["datawise_read", { table: "t" }], ["datawise_query", { query: "select 1" }], ["datawise_count", { table: "t" }], ["datawise_explain", { query: "select 1" }], ["datawise_history", {}], ["datawise_propose_query", { query: "delete from t" }], ["datawise_propose_write", { table: "t", delete: [{ id: 1 }] }], ["datawise_propose_disconnect", {}], ["datawise_propose_connection_change", { changes: { group: "x" } }], ["datawise_propose_reset_ssh_key", {}], ["datawise_test_connection", {}], ["datawise_read_row", { table: "t", key: { id: 1 } }], ["datawise_propose_destroy", { table: "t", action: "drop" }], ["datawise_propose_import", { table: "t", format: "csv", text: "id\n5", mapping: { id: "id" } }], ["datawise_propose_export", { table: "t", format: "csv", fileName: "x" }], ["datawise_export_text", { table: "t", format: "csv" }], ["datawise_save_query", { name: "x", text: "select 1" }], ["datawise_propose_delete_saved_query", { name: "x" }], ["datawise_clear_history", {}], ["datawise_query_tabs", { action: "list" }], ["datawise_table_view", { table: "t", action: "get" }]];
    for (const [tool, input] of calls) {
      const answer = await second.use(tool, { connection: "Dev", ...input });
      expect(answer.isError, `${tool}: ${answer.text}`).toBe(true);
      expect(answer.text, tool).toMatch(/No (shared )?connection named Dev/);
    }
  });

  async function status(use: (name: string, input: unknown) => Promise<{ text?: string }>, requestId: string, until: RegExp) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const text = String((await use("datawise_write_status", { requestId })).text);
      if (until.test(text)) return text;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("the request never finished");
  }
  const requestIdOf = (answer: { text?: string }) => /Request (\S+) is waiting/.exec(String(answer.text))?.[1] as string;

  it("runs an approved app action through the app's handler, and nothing before approval", async () => {
    const { use, call } = await shared("none");
    const requestId = requestIdOf(await use("datawise_propose_disconnect", { connection: "Dev" }));
    expect(await status(use, requestId, /./)).toMatch(/Waiting for the person/);
    const { events } = (await call("agent-activity.list", {})) as { events: { action: string }[] };
    expect(events.map((event) => event.action)).toEqual(["proposed"]);
    await call("agent-requests.decide", { id: requestId, approve: true });
    expect(await status(use, requestId, /^(Done|It failed)/)).toBe("Done.");
  });

  it("refuses an approved disconnect while a job runs on the connection", async () => {
    const { use, call } = await shared("none");
    const connectionId = ((await call("connections.list", {})) as { connections: { id: string }[] }).connections[0]?.id;
    const slow = (await call("query.run", { scope: { connectionId }, text: "with recursive c(x) as (select 1 union all select x + 1 from c where x < 30000000) select count(*) from c" })) as { job: { id: string } };
    const requestId = requestIdOf(await use("datawise_propose_disconnect", { connection: "Dev" }));
    await call("agent-requests.decide", { id: requestId, approve: true });
    expect(await status(use, requestId, /^(Done|It failed)/)).toMatch(/It failed/);
    await call("jobs.cancel", { id: slow.job.id });
  });

  it("drops a waiting action when the person saves the connection", async () => {
    const { use, call } = await shared("none");
    const saved = ((await call("connections.list", {})) as { connections: Record<string, unknown>[] }).connections[0] as Record<string, unknown>;
    const requestId = requestIdOf(await use("datawise_propose_disconnect", { connection: "Dev" }));
    await call("connections.save", { ...saved, group: "moved" });
    expect(await status(use, requestId, /./)).toMatch(/expired/);
  });

  it("proposes a connection with no secret and no guard, saved only by the person's form", async () => {
    const { use, call } = await shared("none");
    const answer = await use("datawise_propose_connection", { name: "Pg", engine: "postgres", host: "db.example", port: 5432, user: "app", password: "leak", environment: "development", agentAccess: "schema", agentRowAccess: "propose", safety: "open" });
    const requestId = requestIdOf(answer);
    const detail = (await call("agent-requests.get", { id: requestId })) as { connectionProposal: Record<string, unknown>; request: { kind: string } };
    expect(detail.request.kind).toBe("connection");
    expect(Object.keys(detail.connectionProposal).sort()).toEqual(["engine", "host", "name", "port", "user"]);
    expect(((await call("connections.list", {})) as { connections: { name: string }[] }).connections.map((item) => item.name)).toEqual(["Dev"]);
    await expect(call("agent-requests.decide", { id: requestId, approve: true })).rejects.toThrow(/saving the connection in the form/);
    const saved = (await call("connections.save", { ...detail.connectionProposal, password: "typed by the person", agentRequestId: requestId })) as { name: string; environment: string; agentAccess: string };
    expect(saved).toMatchObject({ name: "Pg", environment: "none", agentAccess: "none" });
    expect(await status(use, requestId, /./)).toMatch(/The person saved the connection Pg/);
    await expect(call("connections.save", { ...detail.connectionProposal, name: "Pg again", agentRequestId: requestId })).rejects.toThrow(/no longer waiting/);
  });

  it("refuses a proposed name that is taken", async () => {
    const { use } = await shared("none");
    expect((await use("datawise_propose_connection", { name: "Dev", engine: "sqlite", file: "/tmp/x.db" })).text).toMatch(/already named Dev/);
  });

  it("clears the saved password and the sharing when a change moves where the connection points", async () => {
    const { use, call, folder } = await shared("none");
    const pg = (await call("connections.save", { name: "Pg", engine: "postgres", host: "a.example", port: 5432, user: "app", password: "kept-secret", environment: "development", agentAccess: "schema", agentRowAccess: "read" })) as Record<string, unknown>;
    const requestId = requestIdOf(await use("datawise_propose_connection_change", { connection: "Pg", changes: { host: "b.example" } }));
    const detail = (await call("agent-requests.get", { id: requestId })) as { connectionProposal: Record<string, unknown> };
    expect(detail.connectionProposal).toEqual({ host: "b.example" });
    await call("connections.save", { ...pg, ...detail.connectionProposal, agentRequestId: requestId });
    const stored = (JSON.parse(readFileSync(join(folder, "connections.json"), "utf8")) as { connections: Record<string, unknown>[] }).connections.find((item) => item.name === "Pg") as Record<string, unknown>;
    expect(stored).toMatchObject({ host: "b.example", password: null, agentAccess: "none", agentRowAccess: "none" });
    expect(JSON.stringify(stored)).not.toContain("kept-secret");
  });

  it("keeps the saved password when a change does not move the connection", async () => {
    const { use, call, folder } = await shared("none");
    const pg = (await call("connections.save", { name: "Pg", engine: "postgres", host: "a.example", port: 5432, user: "app", password: "kept-secret" })) as Record<string, unknown>;
    const requestId = requestIdOf(await use("datawise_propose_connection_change", { connection: "Pg", changes: { group: "Team" } }));
    await call("connections.save", { ...pg, group: "Team", agentRequestId: requestId });
    const stored = (JSON.parse(readFileSync(join(folder, "connections.json"), "utf8")) as { connections: Record<string, unknown>[] }).connections.find((item) => item.name === "Pg") as Record<string, unknown>;
    expect(stored).toMatchObject({ group: "Team", password: "kept-secret" });
  });

  it("tests a connection, and stops after a failure until the person tests it", async () => {
    const { use, call } = await shared("none");
    expect((await use("datawise_test_connection", { connection: "Dev" })).text).toBe("Connected.");
    const pg = (await call("connections.save", { name: "Gone", engine: "postgres", host: "127.0.0.1", port: 1, user: "x", password: "y" })) as Record<string, unknown>;
    expect((await use("datawise_test_connection", { connection: "Gone" })).text).toMatch(/Could not connect/);
    expect((await use("datawise_test_connection", { connection: "Gone" })).text).toMatch(/last test of this connection failed/);
    await call("connections.test", pg);
    expect((await use("datawise_test_connection", { connection: "Gone" })).text).toMatch(/Wait 10 seconds|Could not connect/);
    await call("connections.save", { name: "Session", engine: "postgres", host: "127.0.0.1", port: 1, user: "x", rememberPassword: false });
    expect((await use("datawise_test_connection", { connection: "Session" })).text).toMatch(/session only/);
  });

  it("drops a table only after the person types its name", async () => {
    const { use, call, folder } = await shared("propose");
    const tableExists = () => {
      const db = new DatabaseSync(join(folder, "dev.db"));
      const found = db.prepare("select count(*) as n from sqlite_master where name = 't'").get() as { n: number };
      db.close();
      return found.n === 1;
    };
    const first = requestIdOf(await use("datawise_propose_destroy", { connection: "Dev", table: "t", action: "drop" }));
    expect(((await call("agent-requests.get", { id: first })) as { typeToConfirm: string }).typeToConfirm).toBe("t");
    await call("agent-requests.decide", { id: first, approve: true });
    expect(await status(use, first, /^(Done|It failed)/)).toMatch(/It failed/);
    const wrong = requestIdOf(await use("datawise_propose_destroy", { connection: "Dev", table: "t", action: "drop" }));
    await call("agent-requests.decide", { id: wrong, approve: true, confirmName: "T" });
    expect(await status(use, wrong, /^(Done|It failed)/)).toMatch(/It failed/);
    expect(tableExists()).toBe(true);
    const right = requestIdOf(await use("datawise_propose_destroy", { connection: "Dev", table: "t", action: "drop" }));
    await call("agent-requests.decide", { id: right, approve: true, confirmName: "t" });
    expect(await status(use, right, /^(Done|It failed)/)).toMatch(/^Done/);
    expect(tableExists()).toBe(false);
  });

  it("imports rows given as text only after approval", async () => {
    const { use, call, folder } = await shared("propose");
    const count = () => {
      const db = new DatabaseSync(join(folder, "dev.db"));
      const found = db.prepare("select count(*) as n from t").get() as { n: number };
      db.close();
      return found.n;
    };
    const requestId = requestIdOf(await use("datawise_propose_import", { connection: "Dev", table: "t", format: "csv", text: "id,note\n2,b\n3,c\n", mapping: { id: "id", note: "note" } }));
    expect(count()).toBe(1);
    await call("agent-requests.decide", { id: requestId, approve: true });
    expect(await status(use, requestId, /^(Done|It failed)/)).toMatch(/^Done/);
    expect(count()).toBe(3);
  });

  it("exports to a new file in the export folder only after approval, and refuses any other path", async () => {
    const { use, call, folder } = await shared("read");
    for (const fileName of ["../x", "/tmp/x", ".zshenv", "a/b"]) expect((await use("datawise_propose_export", { connection: "Dev", table: "t", format: "csv", fileName })).text).toMatch(/file name only/);
    const requestId = requestIdOf(await use("datawise_propose_export", { connection: "Dev", table: "t", format: "csv", fileName: "notes" }));
    const exports = join(folder, "exports");
    expect(existsSync(exports) ? readdirSync(exports) : []).toEqual([]);
    await call("agent-requests.decide", { id: requestId, approve: true });
    expect(await status(use, requestId, /^(Done|It failed)/)).toMatch(/^Done/);
    const files = readdirSync(exports);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^notes-.*\.csv$/);
    expect(readFileSync(join(exports, files[0] as string), "utf8")).toContain("note");
  });

  it("exports as text at once, and reads one row and the structure lists", async () => {
    const { use } = await shared("read");
    expect((await use("datawise_export_text", { connection: "Dev", table: "t", format: "csv" })).text).toMatch(/id,note\s+1,a/);
    expect((await use("datawise_read_row", { connection: "Dev", table: "t", key: { id: 1 } })).text).toContain('"row":[1,"a"]');
    expect((await use("datawise_read_row", { connection: "Dev", table: "t", key: { id: 9 } })).text).toBe("No row has that key.");
    expect((await use("datawise_describe", { connection: "Dev", list: "databases" })).text).toMatch(/no databases to list/);
  });

  it("saves a query under a new name only, and logs it", async () => {
    const { use, call } = await shared("none");
    expect((await use("datawise_save_query", { connection: "Dev", name: "Monthly", text: "select 1" })).text).toBe("Saved Monthly.");
    expect((await use("datawise_save_query", { connection: "Dev", name: "Monthly", text: "delete from t" })).text).toMatch(/already named Monthly/);
    const { events } = (await call("agent-activity.list", {})) as { events: { action: string; change?: string }[] };
    expect(events[0]).toMatchObject({ action: "done", change: "saved query Monthly" });
  });

  it("deletes a saved query only after approval, and not if its text changed", async () => {
    const { use, call } = await shared("none");
    const connectionId = ((await call("connections.list", {})) as { connections: { id: string }[] }).connections[0]?.id as string;
    const saved = (await call("saved.save", { connectionId, name: "Monthly", text: "select 1" })) as { id: string };
    const changed = requestIdOf(await use("datawise_propose_delete_saved_query", { connection: "Dev", name: "Monthly" }));
    await call("saved.save", { connectionId, id: saved.id, name: "Monthly", text: "select 2" });
    await call("agent-requests.decide", { id: changed, approve: true });
    expect(await status(use, changed, /^(Done|It failed)/)).toMatch(/It failed/);
    const requestId = requestIdOf(await use("datawise_propose_delete_saved_query", { connection: "Dev", name: "Monthly" }));
    expect(((await call("saved.list", { connectionId })) as { queries: unknown[] }).queries).toHaveLength(1);
    await call("agent-requests.decide", { id: requestId, approve: true });
    expect(await status(use, requestId, /^(Done|It failed)/)).toBe("Done.");
    expect(((await call("saved.list", { connectionId })) as { queries: unknown[] }).queries).toHaveLength(0);
  });

  it("clears history at once and logs it", async () => {
    const { use, run, call } = await shared("none");
    await run("select 1");
    const connectionId = ((await call("connections.list", {})) as { connections: { id: string }[] }).connections[0]?.id as string;
    expect((await use("datawise_clear_history", { connection: "Dev" })).text).toMatch(/Cleared/);
    expect(((await call("history.list", { connectionId })) as { entries: unknown[] }).entries).toHaveLength(0);
  });

  it("lists tab names without text, renames, and closes only tabs whose text is saved or empty", async () => {
    const { use, call, window, pushed } = await shared("none");
    const connectionId = ((await call("connections.list", {})) as { connections: { id: string }[] }).connections[0]?.id as string;
    await call("workspace.tabs.save", { connectionId, tabs: { activeId: "a", tabs: [{ id: "a", name: "One", text: "CREATE USER u PASSWORD 'canary'" }, { id: "b", name: "Two", text: "" }] } });
    window();
    const listed = String((await use("datawise_query_tabs", { connection: "Dev", action: "list" })).text);
    expect(listed).not.toContain("canary");
    expect(JSON.parse(listed)).toEqual([{ id: "a", name: "One" }, { id: "b", name: "Two" }]);
    expect((await use("datawise_query_tabs", { connection: "Dev", action: "close", tabId: "a" })).text).toMatch(/saved nowhere else/);
    await use("datawise_query_tabs", { connection: "Dev", action: "rename", tabId: "a", name: "Renamed" });
    await use("datawise_query_tabs", { connection: "Dev", action: "close", tabId: "b" });
    expect(pushed).toEqual([{ kind: "tabs", connectionId, renamed: [{ id: "a", name: "Renamed" }], closed: [] }, { kind: "tabs", connectionId, renamed: [], closed: [{ id: "b", text: "" }] }]);
    const stored = ((await call("workspace.tabs.get", { connectionId })) as { tabs: { tabs: { name: string }[] } }).tabs.tabs;
    expect(stored.map((tab) => tab.name)).toEqual(["Renamed"]);
    expect((await use("datawise_query_tabs", { connection: "Dev", action: "close", tabId: "a" })).text).toMatch(/last tab/);
  });

  it("reads and changes how a table is shown, never returning filters", async () => {
    const { use, call, window, pushed } = await shared("none");
    const connectionId = ((await call("connections.list", {})) as { connections: { id: string }[] }).connections[0]?.id as string;
    await call("views.save", { ref: { connectionId, name: "t" }, view: { filtersInUse: [{ column: "note", op: "eq", value: "secret-filter" }] } });
    window();
    expect((await use("datawise_table_view", { connection: "Dev", table: "t", action: "get" })).text).not.toContain("secret-filter");
    await use("datawise_table_view", { connection: "Dev", table: "t", action: "set", hiddenColumns: ["note"] });
    expect(pushed[0]).toMatchObject({ kind: "view", hiddenColumns: ["note"] });
    const view = (await call("views.get", { connectionId, name: "t" })) as { hiddenColumns: string[]; filtersInUse: unknown[] };
    expect(view).toMatchObject({ hiddenColumns: ["note"], filtersInUse: [{ value: "secret-filter" }] });
  });

  it("counts at-once changes toward the per-agent limit, and stops agent saves at 200 per connection", async () => {
    const { use, call } = await shared("none");
    for (let index = 0; index < 60; index += 1) expect((await use("datawise_clear_history", { connection: "Dev" })).isError).toBeFalsy();
    expect((await use("datawise_save_query", { connection: "Dev", name: "late", text: "select 1" })).text).toMatch(/in the last minute/);
    const connectionId = ((await call("connections.list", {})) as { connections: { id: string }[] }).connections[0]?.id as string;
    for (let index = 0; index < 200; index += 1) await call("saved.save", { connectionId, name: `q${index}`, text: "select 1" });
    expect((await use("datawise_save_query", { connection: "Dev", name: "one more", text: "select 1" }, { id: "agent-b", title: null, workspaceId: null })).text).toMatch(/already has 200 saved queries/);
  });

  it("counts new-connection proposals per agent, not in one shared queue", async () => {
    const { use } = await shared("none");
    for (let agent = 0; agent < 5; agent += 1) {
      for (let index = 0; index < 4; index += 1) expect((await use("datawise_propose_connection", { name: `c${agent}-${index}`, engine: "sqlite", file: "/tmp/x.db" }, { id: `agent-${agent}`, title: null, workspaceId: null })).text).toMatch(/is waiting/);
    }
    expect((await use("datawise_propose_connection", { name: "one more", engine: "sqlite", file: "/tmp/x.db" }, { id: "agent-9", title: null, workspaceId: null })).text).toMatch(/is waiting/);
  });

  it("never sends the saved password when the person tests an agent's change that moves the connection", async () => {
    const { use, call } = await shared("none");
    // A minimal PostgreSQL server: it asks for a plain-text password and records everything the client sends.
    const listen = async () => {
      const received: Buffer[] = [];
      const server: Server = createServer((socket) => {
        let asked = false;
        socket.on("data", (chunk) => {
          received.push(chunk);
          if (!asked) {
            asked = true;
            socket.write(Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 3]));
          } else socket.destroy();
        });
        socket.on("error", () => undefined);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return { server, received, port: (server.address() as { port: number }).port };
    };
    const first = await listen();
    const second = await listen();
    try {
      const pg = (await call("connections.save", { name: "Pg", engine: "postgres", host: "127.0.0.1", port: first.port, user: "app", database: "app", password: "kept-secret" })) as Record<string, unknown>;
      // The control: the person's own test of the saved connection does send the saved password.
      await call("connections.test", pg);
      expect(Buffer.concat(first.received).toString("latin1")).toContain("kept-secret");
      const requestId = requestIdOf(await use("datawise_propose_connection_change", { connection: "Pg", changes: { port: second.port } }));
      await call("connections.test", { ...pg, port: second.port, agentRequestId: requestId });
      expect(Buffer.concat(second.received).length).toBeGreaterThan(0);
      expect(Buffer.concat(second.received).toString("latin1")).not.toContain("kept-secret");
    } finally {
      first.server.close();
      second.server.close();
    }
  });

  it("logs a statement proposal as statements, not rows", async () => {
    const { use, call } = await shared("propose");
    await use("datawise_propose_query", { connection: "Dev", query: "delete from t; delete from t" });
    const { events } = (await call("agent-activity.list", {})) as { events: { action: string; rows: number; unit: string }[] };
    expect(events.find((event) => event.action === "proposed")).toMatchObject({ rows: 2, unit: "statements" });
  });

  it("logs only actions an older Datawise can read", async () => {
    const { use, call } = await shared();
    await use("datawise_query", { connection: "Dev", query: "select * from t" });
    await use("datawise_count", { connection: "Dev", table: "t" });
    await use("datawise_explain", { connection: "Dev", query: "select * from t" });
    await use("datawise_propose_query", { connection: "Dev", query: "delete from t" });
    // The action values of v0.5.0's agentActivityEvent. A value outside them makes that release drop the whole log.
    const olderActions = ["read", "proposed", "approved", "rejected", "expired", "done", "failed"];
    const { events } = (await call("agent-activity.list", {})) as { events: { action: string }[] };
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(olderActions).toContain(event.action);
  });
});
