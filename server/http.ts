import { type IncomingMessage, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ConnectionOptions } from "node:tls";

export interface HttpTarget {
  protocol: "http:" | "https:";
  host: string;
  port: number;
  // Name checked against the certificate; differs from host behind an SSH tunnel.
  // Node's TLS options, from tlsClientOptions, so the certificate is checked against the named host.
  tls: ConnectionOptions;
  headers: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

// Refuses a path that could point the request, and its credentials, at another host.
export function checkedPath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || /[\s\\]/.test(path) || path.includes("://")) throw new Error(`Not a path on this server: ${path.slice(0, 200)}`);
  return path;
}

// For results too large to hold: gives the response as a stream, and the caller reads what it needs.
export function httpOpen(target: HttpTarget, method: string, path: string, body: string | null, options: { contentType?: string; signal?: AbortSignal }): Promise<IncomingMessage> {
  const safePath = checkedPath(path);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      {
        protocol: target.protocol,
        host: target.host,
        port: target.port,
        method,
        path: safePath,
        ...target.tls,
        signal: options.signal,
        headers: { ...target.headers, ...(body !== null ? { "content-type": options.contentType ?? "text/plain", "content-length": Buffer.byteLength(body) } : {}) },
      },
      resolve,
    );
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

export function httpCall(target: HttpTarget, method: string, path: string, body: string | null, options: { contentType?: string; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {}): Promise<HttpResponse> {
  const safePath = checkedPath(path);
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const req = send(
      {
        protocol: target.protocol,
        host: target.host,
        port: target.port,
        method,
        path: safePath,
        ...target.tls,
        signal: options.signal,
        timeout: options.timeoutMs ?? 60000,
        headers: { ...target.headers, ...(body !== null ? { "content-type": options.contentType ?? "application/json", "content-length": Buffer.byteLength(body) } : {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            req.destroy(new Error(`The response is larger than ${Math.round(maxBytes / 1048576)} MiB. Ask for fewer rows.`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("The server did not answer in time.")));
    req.on("error", reject);
    if (body !== null) req.write(body);
    req.end();
  });
}
