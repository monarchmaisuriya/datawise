import { type ConnectionOptions, checkServerIdentity, type PeerCertificate } from "node:tls";
import { isIP } from "node:net";
import type { Endpoint } from "./adapters/types";
import type { StoredConnection } from "./store";

// Client TLS options for the drivers that pass them to Node. In verified mode the certificate is checked
// against the host the user named, even when the socket really goes to a local tunnel port. Node's own
// check would otherwise use whatever address it was given, or "localhost" when it was given a socket.
export function tlsClientOptions(connection: StoredConnection, endpoint: Pick<Endpoint, "tlsServername">): ConnectionOptions {
  const name = endpoint.tlsServername;
  const verify = connection.tls === "verify";
  return {
    rejectUnauthorized: verify,
    ca: connection.caCertificate || undefined,
    // TLS does not allow an IP address as a server name.
    servername: isIP(name) ? undefined : name,
    // Left out otherwise: Node refuses this property when it is present but undefined.
    ...(verify ? { checkServerIdentity: (_host: string, certificate: PeerCertificate) => checkServerIdentity(name, certificate) } : {}),
  };
}
