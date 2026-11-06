import { ENGINES } from "../shared/engines";
import { ADAPTERS } from "./adapters";
import type { Adapter, Endpoint } from "./adapters/types";
import type { Store, StoredConnection } from "./store";
import { openTunnel, type Tunnel } from "./tunnel";

const DEFAULT_IDLE_CLOSE_MS = 10 * 60 * 1000;

interface Live {
  adapter: Promise<Adapter>;
  tunnel: Tunnel | null;
  lastUsed: number;
  busy: number;
}

async function build(connection: StoredConnection, onTunnel: (tunnel: Tunnel) => void, onLost: () => void): Promise<Adapter> {
  const engine = ENGINES[connection.engine];
  let endpoint: Endpoint | null = null;
  if (engine.fields.includes("host")) {
    if (!connection.host) throw new Error(`${engine.label} needs a host.`);
    const port = connection.port ?? engine.defaultPort;
    if (port === null) throw new Error(`${engine.label} needs a port.`);
    endpoint = { host: connection.host, port, tlsServername: connection.host };
    if (connection.ssh && engine.supportsSsh) {
      const tunnel = await openTunnel(connection, { host: connection.host, port }, onLost);
      onTunnel(tunnel);
      endpoint = { host: tunnel.host, port: tunnel.port, tlsServername: connection.host };
    }
  }
  return ADAPTERS[connection.engine]({ connection, endpoint, onLost });
}

// One live adapter per connection. Idle ones close. A lost one is dropped, and the next request builds
// a new one, so a server restart does not need any action from the user.
export class Pool {
  private readonly live = new Map<string, Live>();
  private readonly timer: NodeJS.Timeout;
  private idleCloseMs = DEFAULT_IDLE_CLOSE_MS;

  constructor(private readonly store: Store) {
    this.timer = setInterval(() => this.closeIdle(), 60000);
    this.timer.unref();
  }

  private closeIdle() {
    const now = Date.now();
    for (const [id, entry] of this.live) if (entry.busy === 0 && now - entry.lastUsed > this.idleCloseMs) void this.disconnect(id);
  }

  setIdleCloseMinutes(minutes: number) {
    this.idleCloseMs = minutes * 60 * 1000;
  }

  // For callers that must not cause a connection, such as a search on every keystroke.
  isOpen(connectionId: string): boolean {
    return this.live.has(connectionId);
  }

  async use<T>(connectionId: string, work: (adapter: Adapter, connection: StoredConnection) => Promise<T>): Promise<T> {
    const connection = await this.store.getConnection(connectionId);
    if (connection.password === null && !connection.rememberPassword) throw new Error("This connection keeps its password for the session only. Enter it to connect.");
    let entry = this.live.get(connectionId);
    if (!entry) {
      const fresh: Live = {
        adapter: build(
          connection,
          (tunnel) => {
            fresh.tunnel = tunnel;
            if (connection.sshHostFingerprint === null) void this.store.setSshFingerprint(connection.id, tunnel.fingerprint);
          },
          () => void this.disconnect(connectionId),
        ),
        tunnel: null,
        lastUsed: Date.now(),
        busy: 0,
      };
      this.live.set(connectionId, fresh);
      fresh.adapter.catch(() => {
        if (this.live.get(connectionId) === fresh) this.live.delete(connectionId);
      });
      entry = fresh;
    }
    entry.busy += 1;
    entry.lastUsed = Date.now();
    try {
      return await work(await entry.adapter, connection);
    } finally {
      entry.busy -= 1;
      entry.lastUsed = Date.now();
    }
  }

  async disconnect(connectionId: string): Promise<void> {
    const entry = this.live.get(connectionId);
    if (!entry) return;
    this.live.delete(connectionId);
    try {
      await (await entry.adapter).close();
    } catch {
      // Closing a connection that already failed has nothing further to report.
    }
    entry.tunnel?.close();
  }

  // Tries a connection that may not be saved, and always cleans up after itself.
  async test(connection: StoredConnection): Promise<{ serverVersion: string; latencyMs: number; fingerprint: string | null }> {
    let tunnel: Tunnel | null = null;
    const started = Date.now();
    const adapter = await build(
      connection,
      (opened) => {
        tunnel = opened;
      },
      () => undefined,
    );
    try {
      const { serverVersion } = await adapter.ping();
      return { serverVersion, latencyMs: Date.now() - started, fingerprint: (tunnel as Tunnel | null)?.fingerprint ?? null };
    } finally {
      await adapter.close().catch(() => undefined);
      (tunnel as Tunnel | null)?.close();
    }
  }

  async closeAll(): Promise<void> {
    clearInterval(this.timer);
    await Promise.allSettled([...this.live.keys()].map((id) => this.disconnect(id)));
  }
}
