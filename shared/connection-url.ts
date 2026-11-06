import { ENGINES, type EngineId } from "./engines";

export interface ParsedUrl {
  engine: EngineId;
  host: string;
  port: number | null;
  user: string;
  password: string;
  database: string;
  useTls: boolean;
}

const SCHEMES: Record<string, { engine: EngineId; tls?: boolean }> = {
  postgres: { engine: "postgres" },
  postgresql: { engine: "postgres" },
  mysql: { engine: "mysql" },
  mariadb: { engine: "mysql" },
  mongodb: { engine: "mongodb" },
  redis: { engine: "redis" },
  rediss: { engine: "redis", tls: true },
  valkey: { engine: "redis" },
  clickhouse: { engine: "clickhouse" },
  http: { engine: "elasticsearch" },
  https: { engine: "elasticsearch", tls: true },
  sqlserver: { engine: "mssql" },
  mssql: { engine: "mssql" },
  oracle: { engine: "oracle" },
  cassandra: { engine: "cassandra" },
  neo4j: { engine: "neo4j" },
  bolt: { engine: "neo4j" },
  "bolt+s": { engine: "neo4j", tls: true },
  "neo4j+s": { engine: "neo4j", tls: true },
};

// Fills the form from a pasted URL. Returns null when the text is not a URL this plugin knows.
export function parseConnectionUrl(text: string): ParsedUrl | null {
  const match = /^([a-z0-9+]+):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?(\[[^\]]+\]|[^:/?#]*)(?::(\d+))?(?:\/([^?#]*))?(\?[^#]*)?/i.exec(text.trim());
  if (!match) return null;
  const known = SCHEMES[match[1]?.toLowerCase() ?? ""];
  if (!known) return null;
  const decode = (value: string | undefined) => {
    try {
      return decodeURIComponent(value ?? "");
    } catch {
      return value ?? "";
    }
  };
  // By hand: React Native's URLSearchParams has no get().
  const sslMode = /[?&](?:sslmode|ssl|tls)=([^&]*)/i.exec(match[7] ?? "")?.[1]?.toLowerCase() ?? null;
  return {
    engine: known.engine,
    host: match[4]?.replace(/^\[|\]$/g, "") ?? "",
    port: match[5] ? Number(match[5]) : ENGINES[known.engine].defaultPort,
    user: decode(match[2]),
    password: decode(match[3]),
    database: decode(match[6]),
    useTls: known.tls === true || (sslMode !== null && !["disable", "false", "off"].includes(sslMode)),
  };
}
