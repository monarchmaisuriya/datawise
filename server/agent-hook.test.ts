import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rpc, searchStructure, subscriptions } from "../shared/contracts";
import { NEVER_FOR_AGENTS, TOOL_FOR_ACTION } from "./agent-actions";
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
      // The tools are exactly those the coverage map names, so a tool cannot exist unmapped, or be mapped and missing.
      const mapped = [...new Set(Object.values(TOOL_FOR_ACTION).flatMap((tools) => tools.split(", ")))].sort();
      expect(second.tools.map((tool) => tool.name).sort()).toEqual(mapped);
    } finally {
      await stop();
    }
  });
});

describe("every app action", () => {
  it("is reached by an agent tool or listed as never for agents, and not both", () => {
    const actions = [...Object.values(rpc), searchStructure, ...Object.values(subscriptions)].map((contract) => contract.name);
    const missing = actions.filter((name) => !(name in TOOL_FOR_ACTION) && !(name in NEVER_FOR_AGENTS));
    const both = actions.filter((name) => name in TOOL_FOR_ACTION && name in NEVER_FOR_AGENTS);
    const unknown = [...Object.keys(TOOL_FOR_ACTION), ...Object.keys(NEVER_FOR_AGENTS)].filter((name) => !actions.includes(name));
    expect({ missing, both, unknown }).toEqual({ missing: [], both: [], unknown: [] });
  });
});
