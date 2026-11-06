import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import type { Client as SshClient, ConnectConfig } from "ssh2";
import { loadDriver } from "./drivers";
import type { StoredConnection } from "./store";

export interface Tunnel {
  host: string;
  port: number;
  fingerprint: string;
  close(): void;
}

// Pins the server's key on first use. A later change is refused, because a changed key is what a
// machine in the middle would present; the user clears the pin if the change is legitimate.
export async function openTunnel(connection: StoredConnection, target: { host: string; port: number }, onLost: () => void): Promise<Tunnel> {
  const ssh = connection.ssh;
  if (!ssh) throw new Error("This connection has no SSH settings.");
  const { Client } = await loadDriver<typeof import("ssh2")>("ssh2");
  const client: SshClient = new Client();
  let fingerprint = "";
  const config: ConnectConfig = {
    host: ssh.host,
    port: ssh.port,
    username: ssh.user,
    password: connection.sshPassword ?? undefined,
    privateKey: connection.sshPrivateKey ?? undefined,
    passphrase: connection.sshPassphrase ?? undefined,
    readyTimeout: 15000,
    keepaliveInterval: 15000,
    hostVerifier: (key: Buffer) => {
      fingerprint = `SHA256:${createHash("sha256").update(key).digest("base64")}`;
      return connection.sshHostFingerprint === null || connection.sshHostFingerprint === fingerprint;
    },
  };

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      const changed = fingerprint !== "" && connection.sshHostFingerprint !== null && fingerprint !== connection.sshHostFingerprint;
      reject(changed ? new Error(`The SSH server's key changed from ${connection.sshHostFingerprint} to ${fingerprint}. Clear the saved key on the connection only if you expected this.`) : error);
    };
    client.once("ready", () => {
      client.off("error", onError);
      resolve();
    });
    client.once("error", onError);
    client.connect(config);
  });

  const server: Server = createServer((socket) => {
    client.forwardOut("127.0.0.1", 0, target.host, target.port, (error, stream) => {
      if (error) {
        socket.destroy(error);
        return;
      }
      socket.pipe(stream).pipe(socket);
      stream.on("error", () => socket.destroy());
      socket.on("error", () => stream.destroy());
    });
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    server.close();
    client.end();
  };
  client.on("close", () => {
    if (!closed) onLost();
    close();
  });
  client.on("error", () => {
    if (!closed) onLost();
    close();
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    // Loopback only: this port forwards into the remote network without further authentication.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("Could not open a local port for the SSH tunnel."));
    });
  });

  return { host: "127.0.0.1", port, fingerprint, close };
}
