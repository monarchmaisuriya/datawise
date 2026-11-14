import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { contributeServer } from "./plugin";

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
      registerSettings: (definition: { schema: { parse(value: unknown): unknown } }) => ({ read: async () => ({ status: "ready", values: definition.schema.parse({}) }), subscribe: () => () => undefined }),
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
    const calls: [string, Record<string, unknown>][] = [["datawise_describe", {}], ["datawise_read", { table: "t" }], ["datawise_query", { query: "select 1" }], ["datawise_count", { table: "t" }], ["datawise_explain", { query: "select 1" }], ["datawise_history", {}], ["datawise_propose_query", { query: "delete from t" }], ["datawise_propose_write", { table: "t", delete: [{ id: 1 }] }]];
    for (const [tool, input] of calls) {
      const answer = await second.use(tool, { connection: "Dev", ...input });
      expect(answer.isError, `${tool}: ${answer.text}`).toBe(true);
      expect(answer.text, tool).toMatch(/No (shared )?connection named Dev/);
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
