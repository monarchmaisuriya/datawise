import type { ZodType } from "zod";

type Handler = (input: unknown) => unknown;

// Every app action keeps its handler here, so an action an agent proposed runs, once approved, through the very
// handler the app calls, with the same rules. Nothing is copied, so the two paths cannot drift apart.
export class HandlerRegistry {
  private readonly handlers = new Map<string, { input: ZodType; handler: Handler }>();

  record(name: string, input: ZodType, handler: Handler): void {
    this.handlers.set(name, { input, handler });
  }

  // Parsed again at every use: a request waits up to 30 minutes, and what Datawise accepts may have changed.
  parse(name: string, input: unknown): unknown {
    const entry = this.handlers.get(name);
    if (!entry) throw new Error(`Datawise has no action named ${name}.`);
    const parsed = entry.input.safeParse(input);
    if (!parsed.success) throw new Error("This request no longer fits what Datawise accepts, so it was not run.");
    return parsed.data;
  }

  async call(name: string, input: unknown): Promise<unknown> {
    const parsed = this.parse(name, input);
    return (this.handlers.get(name) as { handler: Handler }).handler(parsed);
  }
}

// Wraps the plugin's server so each RPC handler it registers is also recorded. Subscriptions are left alone.
export function recordingHandlers<Server extends { handle: (...args: never[]) => unknown }>(server: Server, registry: HandlerRegistry): Server {
  return new Proxy(server, {
    get(target, property, receiver) {
      if (property !== "handle") return Reflect.get(target, property, receiver);
      return (contract: { name: string; input: ZodType; event?: unknown }, handler: Handler) => {
        if (contract.event === undefined) registry.record(contract.name, contract.input, handler);
        return (target.handle as (...args: unknown[]) => unknown)(contract, handler);
      };
    },
  });
}

// Each app action and the agent tool that reaches it. Together with the list below it names every action once.
export const TOOL_FOR_ACTION: Record<string, string> = {
  "connections.list": "datawise_describe",
  "connections.save": "datawise_propose_connection, datawise_propose_connection_change",
  "connections.test": "datawise_test_connection",
  "connections.disconnect": "datawise_propose_disconnect",
  "connections.clear-ssh-fingerprint": "datawise_propose_reset_ssh_key",
  "schema.databases": "datawise_describe",
  "schema.schemas": "datawise_describe",
  "schema.objects": "datawise_describe",
  "schema.describe": "datawise_describe",
  "attachments.structure": "datawise_describe",
  "data.read": "datawise_read",
  "data.count": "datawise_count",
  "data.read-row": "datawise_read_row",
  "data.write": "datawise_propose_write",
  "data.write-batch": "datawise_propose_write",
  "data.destroy": "datawise_propose_destroy",
  "query.run": "datawise_query, datawise_explain, datawise_propose_query",
  "history.list": "datawise_history",
  "history.clear": "datawise_clear_history",
  "saved.list": "datawise_history",
  "saved.save": "datawise_save_query",
  "saved.delete": "datawise_propose_delete_saved_query",
  "import.preview": "datawise_propose_import",
  "import.start": "datawise_propose_import",
  "export.start": "datawise_propose_export",
  "export.text": "datawise_export_text",
  "views.get": "datawise_table_view",
  "views.save": "datawise_table_view",
  "workspace.tabs.get": "datawise_query_tabs",
  "workspace.tabs.save": "datawise_query_tabs",
  "workspace.place.get": "datawise_open",
  "workspace.place.save": "datawise_open",
  "agent-requests.get": "datawise_write_status",
  "agent.opens": "datawise_open",
};

// Actions no agent tool reaches, and why. OVERVIEW.md lists the same.
export const NEVER_FOR_AGENTS: Record<string, string> = {
  "connections.delete": "it also erases the connection's agent activity entries",
  "connections.unlock": "it takes a password, and secrets never pass through an agent",
  "agent-requests.decide": "approving or rejecting is the person's",
  "agent-requests.list": "the person's view of every agent's requests",
  "agent-activity.list": "the person's record of what agents did",
  "agent-activity.clear": "an agent never clears the record of what it did",
  "sqlite.inspect": "it reads a file on the daemon machine",
  "jobs.status": "no agent tool starts a job it would follow",
  "jobs.cancel": "no agent tool starts a job it would cancel",
  "export.default-path": "the export tool resolves the folder itself",
};
