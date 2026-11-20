import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginOpenSupport, PluginServerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import contribute from "../index.server";
import { rpc, searchStructure, subscriptions } from "../shared/contracts";
import { NEVER_FOR_AGENTS, TOOL_FOR_ACTION } from "./agent-actions";
import { contributeServer } from "./plugin";

type HookRequest = Pick<PluginSessionOpenRequest, "purpose" | "openSupport"> & { tools: { name: string }[] };
type Hook = (input: { request: HookRequest }) => Promise<HookRequest>;

function support(attachedTools: Partial<PluginOpenSupport["attachedTools"]> = {}): PluginOpenSupport {
  return {
    adapter: { kind: "plugin", id: "test-provider" },
    instructions: "supported",
    mcpHttp: "supported",
    exactMcpPreapproval: "supported",
    attachedTools: { delivery: "mcp", enabled: true, disabledTools: [], ...attachedTools },
    restrictions: { mcpConfiguration: "mutable", processEnvironment: "mutable" },
    providerOptions: [],
  };
}

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
  return { hooks, folder, stop: async () => {
    await cleanup();
    rmSync(folder, { recursive: true, force: true });
  } };
}

describe("agent tools", () => {
  it("offers the fixed catalog to supported sessions without consulting sharing", async () => {
    const { hooks, stop } = start();
    try {
      expect(hooks).toHaveLength(1);
      const hook = hooks[0] as Hook;
      const first = await hook({ request: { purpose: "interactive", openSupport: support(), tools: [{ name: "other" }] } });
      const second = await hook({ request: { purpose: "interactive", openSupport: support(), tools: [] } });
      expect(first.tools[0]?.name).toBe("other");
      expect(first.tools.slice(1)).toEqual(second.tools);
      // The tools are exactly those the coverage map names, so a tool cannot exist unmapped, or be mapped and missing.
      const mapped = [...new Set(Object.values(TOOL_FOR_ACTION).flatMap((tools) => tools.split(", ")))].sort();
      expect(second.tools.map((tool) => tool.name).sort()).toEqual(mapped);
    } finally {
      await stop();
    }
  });

  it("restores identical definitions after a limited open without changing stored data", async () => {
    const { hooks, folder, stop } = start();
    try {
      const file = join(folder, "connections.json");
      const saved = '{"version":1,"connections":[{"id":"dev","name":"Dev","engine":"sqlite","file":"unused.db","environment":"development","agentAccess":"schema","agentRowAccess":"read"}],"history":{},"saved":{"dev":[{"id":"saved-read","name":"Read","text":"select 1"}]}}\n';
      writeFileSync(file, saved);
      const hook = hooks[0] as Hook;
      const supported = await hook({ request: { purpose: "interactive", openSupport: support(), tools: [] } });
      const limited = await hook({ request: { purpose: "interactive", openSupport: support({ delivery: "none" }), tools: [{ name: "other" }] } });
      const restored = await hook({ request: { purpose: "interactive", openSupport: support(), tools: [] } });
      expect(limited.tools).toEqual([{ name: "other" }]);
      expect(restored.tools.length).toBeGreaterThan(0);
      expect(restored.tools).toEqual(supported.tools);
      expect(restored.tools[0]).toBe(supported.tools[0]);
      expect(readFileSync(file, "utf8")).toBe(saved);
      expect(hooks).toHaveLength(1);
    } finally {
      await stop();
    }
  });

  it("keeps the catalog with native delivery and no HTTP, instructions or exact approvals", async () => {
    const { hooks, stop } = start();
    try {
      const hook = hooks[0] as Hook;
      const supported = await hook({ request: { purpose: "interactive", openSupport: support(), tools: [] } });
      const native = await hook({ request: { purpose: "interactive", openSupport: { ...support({ delivery: "native" }), instructions: "unsupported", mcpHttp: "unsupported", exactMcpPreapproval: "unsupported" }, tools: [] } });
      expect(native.tools.length).toBeGreaterThan(0);
      expect(native.tools).toEqual(supported.tools);
    } finally {
      await stop();
    }
  });

  it.each(["native", "mcp"] as const)("honors the host tools switch for %s delivery without changing later opens", async (delivery) => {
    const { hooks, stop } = start();
    try {
      const hook = hooks[0] as Hook;
      const disabled = await hook({ request: { purpose: "interactive", openSupport: support({ delivery, enabled: false }), tools: [{ name: "other" }] } });
      const enabled = await hook({ request: { purpose: "interactive", openSupport: support({ delivery }), tools: [] } });
      expect(disabled.tools).toEqual([{ name: "other" }]);
      expect(enabled.tools.length).toBeGreaterThan(0);
    } finally {
      await stop();
    }
  });

  it.each(["native", "mcp"] as const)("omits only explicitly disabled Datawise names for %s delivery", async (delivery) => {
    const { hooks, stop } = start();
    try {
      const hook = hooks[0] as Hook;
      const supported = await hook({ request: { purpose: "interactive", openSupport: support({ delivery }), tools: [] } });
      const openSupport = support({ delivery, disabledTools: Object.freeze(["datawise_read", "datawise_query", "other", "datawise_"]) });
      Object.freeze(openSupport.attachedTools);
      Object.freeze(openSupport);
      const request = Object.freeze({ purpose: "interactive" as const, openSupport, tools: [{ name: "other" }] });
      const limited = await hook({ request });
      const restored = await hook({ request: { purpose: "interactive", openSupport: support({ delivery }), tools: [] } });
      expect(limited.tools[0]).toBe(request.tools[0]);
      expect(limited.tools).toHaveLength(supported.tools.length - 1);
      expect(limited.tools.map((tool) => tool.name)).not.toContain("datawise_read");
      expect(limited.tools.map((tool) => tool.name)).not.toContain("datawise_query");
      expect(limited.tools.map((tool) => tool.name)).toContain("datawise_read_row");
      expect(restored.tools).toEqual(supported.tools);
      expect(request.tools).toEqual([{ name: "other" }]);
      expect(openSupport.attachedTools.disabledTools).toEqual(["datawise_read", "datawise_query", "other", "datawise_"]);
    } finally {
      await stop();
    }
  });

  it("adds no tools for history even when delivery is supported", async () => {
    const { hooks, stop } = start();
    try {
      const hook = hooks[0] as Hook;
      const history = await hook({ request: { purpose: "history", openSupport: support(), tools: [{ name: "other" }] } });
      expect(history.tools).toEqual([{ name: "other" }]);
    } finally {
      await stop();
    }
  });

  it("adds no tools without a support descriptor", async () => {
    const { hooks, stop } = start();
    try {
      const hook = hooks[0] as Hook;
      const unknown = await hook({ request: { purpose: "interactive", tools: [{ name: "other" }] } });
      expect(unknown.tools).toEqual([{ name: "other" }]);
    } finally {
      await stop();
    }
  });

  it("does not read a damaged connection file while deriving the supported catalog", async () => {
    const { hooks, folder, stop } = start();
    try {
      const file = join(folder, "connections.json");
      writeFileSync(file, "not a connection document");
      const hook = hooks[0] as Hook;
      const offered = await hook({ request: { purpose: "interactive", openSupport: support(), tools: [] } });
      expect(offered.tools.length).toBeGreaterThan(0);
      expect(readFileSync(file, "utf8")).toBe("not a connection document");
    } finally {
      await stop();
    }
  });

  it.each(["unknown", "none"] as const)("adds no tools for %s delivery even when enabled", async (delivery) => {
    const { hooks, stop } = start();
    try {
      const hook = hooks[0] as Hook;
      const unavailable = await hook({ request: { purpose: "interactive", openSupport: support({ delivery }), tools: [{ name: "other" }] } });
      expect(unavailable.tools).toEqual([{ name: "other" }]);
    } finally {
      await stop();
    }
  });
});

describe("host support", () => {
  it("rejects an old host at setup with update guidance before registering anything", () => {
    expect(() => contribute({} as PluginServerContext)).toThrow("Update the Paseo host to a version with adaptive agent features before loading Datawise.");
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
