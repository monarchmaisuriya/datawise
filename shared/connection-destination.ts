import type { ConnectionInput } from "./contracts";

// The settings that decide where a connection sends its secrets. One list, so the server's rule and what the form
// tells the person cannot drift apart.
export const DESTINATION_FIELDS = ["engine", "host", "port", "user", "database", "file", "serviceName", "region", "endpoint", "tls", "caCertificate", "ssh"] as const;

type Destination = Pick<ConnectionInput, (typeof DESTINATION_FIELDS)[number]>;

// When this changes, a saved secret must be typed again.
export function secretDestination(connection: Destination): string {
  return JSON.stringify(DESTINATION_FIELDS.map((field) => connection[field] ?? null));
}
