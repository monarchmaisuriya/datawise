import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contributeServer } from "./plugin";

type Hook = (input: { request: { tools: { name: string }[] } }) => Promise<{ tools: { name: string }[] }>;

function start() {
  const folder = mkdtempSync(join(tmpdir(), "datawise-hook-"));
  const hooks: Hook[] = [];
  const cleanup = contributeServer(
    {
      handle: () => undefined,
      registerSettings: (definition: { schema: { parse(value: unknown): unknown } }) => ({ read: async () => ({ status: "ready", values: definition.schema.parse({}) }), subscribe: () => () => undefined }),
      addHook: (_name: string, handler: Hook) => {
        hooks.push(handler);
        return () => undefined;
      },
    } as never,
    folder,
  );
  return { hooks, stop: async () => {
    await cleanup();
    rmSync(folder, { recursive: true, force: true });
  } };
}

describe("agent tools", () => {
  it("are offered to every session, shared or not, as one fixed list", async () => {
    const { hooks, stop } = start();
    try {
      expect(hooks).toHaveLength(1);
      const hook = hooks[0] as Hook;
      const first = await hook({ request: { tools: [{ name: "other" }] } });
      const second = await hook({ request: { tools: [] } });
      expect(first.tools[0]?.name).toBe("other");
      expect(first.tools.slice(1).map((tool) => tool.name)).toEqual(second.tools.map((tool) => tool.name));
      expect(second.tools.map((tool) => tool.name).sort()).toEqual(["datawise_count", "datawise_describe", "datawise_explain", "datawise_history", "datawise_open", "datawise_propose_query", "datawise_propose_write", "datawise_query", "datawise_read", "datawise_write_status"]);
    } finally {
      await stop();
    }
  });
});
