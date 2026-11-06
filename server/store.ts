import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { agentAccess, connectionColor, type ConnectionView, connectionInput, environmentLabel, type HistoryEntry, historyEntry, type SavedQuery, safetyMode, savedQuery, sshInput, tlsMode, engineId } from "../shared/contracts";
import { ENGINES } from "../shared/engines";
import { registerSecret } from "./errors";

const storedConnection = z.object({
  id: z.string(),
  name: z.string(),
  engine: engineId,
  host: z.string().default(""),
  port: z.number().nullable().default(null),
  user: z.string().default(""),
  database: z.string().default(""),
  file: z.string().default(""),
  serviceName: z.string().default(""),
  localDataCenter: z.string().default(""),
  region: z.string().default(""),
  endpoint: z.string().default(""),
  accessKeyId: z.string().default(""),
  authSource: z.string().default(""),
  tls: tlsMode.default("off"),
  caCertificate: z.string().default(""),
  // Missing means the safe default. An unknown value fails the load instead of guessing a mode.
  safety: safetyMode.default("confirm"),
  environment: environmentLabel.default("none"),
  color: connectionColor.nullable().default(null),
  group: z.string().default(""),
  agentAccess: agentAccess.default("none"),
  ssh: sshInput.nullable().default(null),
  rememberPassword: z.boolean().default(true),
  sshHostFingerprint: z.string().nullable().default(null),
  password: z.string().nullable().default(null),
  apiKey: z.string().nullable().default(null),
  sshPassword: z.string().nullable().default(null),
  sshPrivateKey: z.string().nullable().default(null),
  sshPassphrase: z.string().nullable().default(null),
});
export type StoredConnection = z.infer<typeof storedConnection>;

const storeFile = z.object({
  version: z.literal(1),
  connections: z.array(storedConnection),
  history: z.record(z.string(), z.array(historyEntry)).default({}),
  saved: z.record(z.string(), z.array(savedQuery)).default({}),
});
type StoreFile = z.infer<typeof storeFile>;

const HISTORY_LIMIT = 200;
const SECRET_FIELDS = ["password", "apiKey", "sshPassword", "sshPrivateKey", "sshPassphrase"] as const;

function isLoopback(host: string): boolean {
  return host === "" || host === "localhost" || host === "::1" || host.startsWith("127.");
}

export function toView(connection: StoredConnection): ConnectionView {
  return {
    id: connection.id,
    name: connection.name,
    engine: connection.engine,
    host: connection.host,
    port: connection.port,
    user: connection.user,
    database: connection.database,
    file: connection.file,
    serviceName: connection.serviceName,
    localDataCenter: connection.localDataCenter,
    region: connection.region,
    endpoint: connection.endpoint,
    accessKeyId: connection.accessKeyId,
    authSource: connection.authSource,
    tls: connection.tls,
    caCertificate: connection.caCertificate,
    safety: connection.safety,
    environment: connection.environment,
    color: connection.color,
    group: connection.group,
    agentAccess: connection.agentAccess,
    ssh: connection.ssh,
    sshHostFingerprint: connection.sshHostFingerprint,
    rememberPassword: connection.rememberPassword,
    needsPassword: !connection.rememberPassword && connection.password === null,
    hasPassword: connection.password !== null,
    hasApiKey: connection.apiKey !== null,
    hasSshPassword: connection.sshPassword !== null,
    hasSshPrivateKey: connection.sshPrivateKey !== null,
    hasSshPassphrase: connection.sshPassphrase !== null,
    notEncrypted: connection.tls === "off" && connection.ssh === null && connection.engine !== "sqlite" && !isLoopback(connection.host),
  };
}

// Connections, query history and saved queries, in one file only this user can read. Paseo's settings
// documents are not meant for credentials, so this file is the plugin's own.
export class Store {
  private state: StoreFile | null = null;
  private writes: Promise<unknown> = Promise.resolve();

  private loading: Promise<StoreFile> | null = null;

  constructor(private readonly findFolder: () => Promise<string>) {}

  private async path(): Promise<string> {
    return join(await this.findFolder(), "connections.json");
  }

  // One shared load, so two first callers cannot each hold their own copy and lose the other's save.
  private load(): Promise<StoreFile> {
    this.loading ??= this.read().catch((error: unknown) => {
      this.loading = null;
      throw error;
    });
    return this.loading;
  }

  private async read(): Promise<StoreFile> {
    let raw: string | null = null;
    try {
      raw = await readFile(await this.path(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // A damaged file is reported and left alone. Starting empty here would overwrite it on next save.
    const parsed: StoreFile = raw === null ? { version: 1, connections: [], history: {}, saved: {} } : storeFile.parse(JSON.parse(raw));
    for (const connection of parsed.connections) for (const field of SECRET_FIELDS) registerSecret(connection[field]);
    this.state = parsed;
    return parsed;
  }

  // Writes one at a time and replaces the file in one step, so a crash leaves the old file whole.
  private persist(): Promise<void> {
    const write = this.writes.then(async () => {
      const folder = await this.findFolder();
      const path = await this.path();
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await chmod(folder, 0o700);
      const temporary = `${path}.${randomUUID()}.tmp`;
      const state = this.state as StoreFile;
      // A session-only password stays in memory and never reaches this file.
      const onDisk: StoreFile = { ...state, connections: state.connections.map((item) => (item.rememberPassword ? item : { ...item, password: null })) };
      await writeFile(temporary, JSON.stringify(onDisk, null, 2), { mode: 0o600 });
      await rename(temporary, path);
    });
    this.writes = write.catch(() => undefined);
    return write;
  }

  async listConnections(): Promise<StoredConnection[]> {
    return (await this.load()).connections;
  }

  async getConnection(id: string): Promise<StoredConnection> {
    const connection = (await this.load()).connections.find((item) => item.id === id);
    if (!connection) throw new Error("This connection no longer exists.");
    return connection;
  }

  // Applies a form to a stored connection, without saving. Also used by Test on an unsaved form.
  async resolveInput(rawInput: unknown): Promise<StoredConnection> {
    const input = connectionInput.parse(rawInput);
    // Held here, the one path every saved connection takes, so no client can get around them.
    if (input.environment === "production" && input.safety === "open") throw new Error("A production connection cannot run without prompts. Choose Ask first or Read-only.");
    if (input.agentAccess !== "none") {
      if (input.environment === "production") throw new Error("A production connection cannot be shared with agents.");
      if (!ENGINES[input.engine].catalogSchema) throw new Error(`${ENGINES[input.engine].label} structure comes from the data itself, so it cannot be shared with agents without sharing data.`);
    }
    const existing = input.id ? (await this.load()).connections.find((item) => item.id === input.id) : undefined;
    const secret = (field: (typeof SECRET_FIELDS)[number]): string | null => {
      const change = input[field];
      if (change === undefined) return existing?.[field] ?? null;
      return change === null || change === "" ? null : change;
    };
    const resolved: StoredConnection = {
      ...input,
      id: input.id ?? randomUUID(),
      sshHostFingerprint: input.ssh && existing?.ssh?.host === input.ssh.host && existing.ssh.port === input.ssh.port ? existing.sshHostFingerprint : null,
      password: secret("password"),
      apiKey: secret("apiKey"),
      sshPassword: secret("sshPassword"),
      sshPrivateKey: secret("sshPrivateKey"),
      sshPassphrase: secret("sshPassphrase"),
    };
    for (const field of SECRET_FIELDS) registerSecret(resolved[field]);
    return resolved;
  }

  async saveConnection(rawInput: unknown): Promise<StoredConnection> {
    const state = await this.load();
    const resolved = await this.resolveInput(rawInput);
    const index = state.connections.findIndex((item) => item.id === resolved.id);
    if (index === -1) state.connections.push(resolved);
    else state.connections[index] = resolved;
    await this.persist();
    return resolved;
  }

  async deleteConnection(id: string): Promise<void> {
    const state = await this.load();
    state.connections = state.connections.filter((item) => item.id !== id);
    delete state.history[id];
    delete state.saved[id];
    await this.persist();
  }

  async unlock(id: string, password: string): Promise<StoredConnection> {
    const connection = await this.getConnection(id);
    connection.password = password;
    registerSecret(password);
    return connection;
  }

  async setSshFingerprint(id: string, fingerprint: string | null): Promise<StoredConnection> {
    const connection = await this.getConnection(id);
    connection.sshHostFingerprint = fingerprint;
    await this.persist();
    return connection;
  }

  async addHistory(connectionId: string, entry: Omit<HistoryEntry, "id" | "ranAt">, limit = HISTORY_LIMIT): Promise<void> {
    const state = await this.load();
    const entries = state.history[connectionId] ?? [];
    entries.unshift({ ...entry, id: randomUUID(), ranAt: new Date().toISOString() });
    state.history[connectionId] = entries.slice(0, limit);
    await this.persist();
  }

  // Applied when the setting changes, so 0 removes what is there now and not at some later run.
  async trimHistory(limit: number): Promise<void> {
    const state = await this.load();
    for (const [id, entries] of Object.entries(state.history)) state.history[id] = entries.slice(0, limit);
    await this.persist();
  }

  async listHistory(connectionId: string): Promise<HistoryEntry[]> {
    return (await this.load()).history[connectionId] ?? [];
  }

  async clearHistory(connectionId: string): Promise<void> {
    delete (await this.load()).history[connectionId];
    await this.persist();
  }

  async listSaved(connectionId: string): Promise<SavedQuery[]> {
    return (await this.load()).saved[connectionId] ?? [];
  }

  async saveQuery(connectionId: string, query: { id?: string; name: string; text: string }): Promise<SavedQuery> {
    const state = await this.load();
    const list = state.saved[connectionId] ?? [];
    const saved: SavedQuery = { id: query.id ?? randomUUID(), name: query.name, text: query.text };
    const index = list.findIndex((item) => item.id === saved.id);
    if (index === -1) list.push(saved);
    else list[index] = saved;
    state.saved[connectionId] = list;
    await this.persist();
    return saved;
  }

  async deleteSaved(connectionId: string, id: string): Promise<void> {
    const state = await this.load();
    state.saved[connectionId] = (state.saved[connectionId] ?? []).filter((item) => item.id !== id);
    await this.persist();
  }
}
