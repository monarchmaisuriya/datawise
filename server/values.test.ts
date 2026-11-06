import { chmodSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConnectionUrl } from "../shared/connection-url";
import { BYTES_TAG } from "../shared/contracts";
import { inferValue, parseEdited } from "../shared/values";
import { CELL_LIMIT, finishRows, fromCell, toCell } from "./cells";
import { errorMessage, registerSecret, scrubSecrets } from "./errors";
import { exporterFor, sqlTextFor } from "./formats";
import { Store, toView } from "./store";

describe("cells keep their meaning", () => {
  it("keeps big integers exact", () => {
    expect(toCell(9007199254740993n)).toBe("9007199254740993");
    expect(toCell(5n)).toBe(5);
  });
  it("round-trips bytes, and leaves ordinary JSON alone", () => {
    const cell = toCell(new Uint8Array([0, 255]));
    expect(cell).toEqual({ [BYTES_TAG]: "AP8=" });
    expect(fromCell(cell)).toEqual(Buffer.from([0, 255]));
    expect(fromCell({ $bytes: "AP8=" })).toEqual({ $bytes: "AP8=" });
  });
  it("marks cut cells so they are never written back", () => {
    const long = "x".repeat(CELL_LIMIT + 1);
    const finished = finishRows([["a", long]]);
    expect(finished.cutCells).toEqual([[0, 1]]);
    expect((finished.rows[0]?.[1] as string).length).toBe(CELL_LIMIT);
  });
  it("cuts at the row limit and says so", () => {
    const finished = finishRows([[1], [2], [3]], 2);
    expect(finished.rows).toHaveLength(2);
    expect(finished.truncated).toBe(true);
  });
});

describe("secrets", () => {
  it("are removed from messages, in plain and URL-encoded form", () => {
    registerSecret("p@ss word");
    expect(scrubSecrets("failed for p@ss word and p%40ss%20word")).toBe("failed for [hidden] and [hidden]");
  });
  it("are removed from any URL, known or not", () => {
    expect(scrubSecrets("cannot reach postgres://bob:unknown@host/db")).toBe("cannot reach postgres://bob:[hidden]@host/db");
  });
  it("are removed from every error in an AggregateError", () => {
    registerSecret("topsecret");
    expect(errorMessage(new AggregateError([new Error("a topsecret")]))).toBe("a [hidden]");
  });
});

describe("the store", () => {
  const form = { name: "x", engine: "postgres" as const, host: "db", password: "hunter22" };

  it("keeps secrets off the view, and the file at 0600", async () => {
    const folder = mkdtempSync(join(tmpdir(), "dw-store-"));
    const store = new Store(async () => folder);
    const saved = await store.saveConnection(form);
    const view = toView(saved);
    expect(JSON.stringify(view)).not.toContain("hunter22");
    expect(view.hasPassword).toBe(true);
    expect(statSync(join(folder, "connections.json")).mode & 0o777).toBe(0o600);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  });

  it("missing keeps a secret, null clears it, a string replaces it", async () => {
    const store = new Store(async () => mkdtempSync(join(tmpdir(), "dw-store-")));
    const { id } = await store.saveConnection(form);
    expect((await store.saveConnection({ ...form, id, password: undefined })).password).toBe("hunter22");
    expect((await store.saveConnection({ ...form, id, password: "new" })).password).toBe("new");
    expect((await store.saveConnection({ ...form, id, password: null })).password).toBeNull();
  });

  it("never writes a session-only password to disk", async () => {
    const folder = mkdtempSync(join(tmpdir(), "dw-store-"));
    const store = new Store(async () => folder);
    const saved = await store.saveConnection({ ...form, rememberPassword: false });
    expect(saved.password).toBe("hunter22");
    expect(readFileSync(join(folder, "connections.json"), "utf8")).not.toContain("hunter22");
    expect(toView((await new Store(async () => folder).listConnections())[0] as never).needsPassword).toBe(true);
  });

  it("defaults to asking before writes", async () => {
    const store = new Store(async () => mkdtempSync(join(tmpdir(), "dw-store-")));
    expect((await store.saveConnection(form)).safety).toBe("confirm");
  });

  it("refuses a damaged file instead of starting empty and overwriting it", async () => {
    const folder = mkdtempSync(join(tmpdir(), "dw-store-"));
    const store = new Store(async () => folder);
    await store.saveConnection(form);
    const path = join(folder, "connections.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, '{"version":1,"connections":[{"id":"a","name":"a","engine":"postgres","safety":"typo"}]}');
    chmodSync(path, 0o600);
    await expect(new Store(async () => folder).listConnections()).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toContain("typo");
  });

  it("forgets a pinned SSH key when the SSH host changes", async () => {
    const store = new Store(async () => mkdtempSync(join(tmpdir(), "dw-store-")));
    const ssh = { host: "a", port: 22, user: "u" };
    const { id } = await store.saveConnection({ ...form, ssh });
    await store.setSshFingerprint(id, "SHA256:x");
    expect((await store.saveConnection({ ...form, id, ssh })).sshHostFingerprint).toBe("SHA256:x");
    expect((await store.saveConnection({ ...form, id, ssh: { ...ssh, host: "b" } })).sshHostFingerprint).toBeNull();
  });
});

describe("connection URLs", () => {
  it("reads parts, encoded passwords and TLS", () => {
    expect(parseConnectionUrl("postgres://a:p%40ss@h:5/db?sslmode=require")).toMatchObject({ engine: "postgres", host: "h", port: 5, user: "a", password: "p@ss", database: "db", useTls: true });
    expect(parseConnectionUrl("rediss://h")).toMatchObject({ engine: "redis", useTls: true, port: 6379 });
    expect(parseConnectionUrl("postgres://h/db?sslmode=disable")?.useTls).toBe(false);
    expect(parseConnectionUrl("nonsense")).toBeNull();
  });
});

describe("export text", () => {
  const sql = sqlTextFor("postgres");
  it("quotes CSV, and defuses spreadsheet formulas", () => {
    const csv = exporterFor("csv", "t", sql);
    expect(csv.rows(["a"], [['x,"y'], ["=1+1"], ["-5"], [null]])).toBe(`"x,""y"\n'=1+1\n-5\n\n`);
  });
  it("writes valid JSON across batches", () => {
    const json = exporterFor("json", "t", sql);
    const text = json.header(["a"]) + json.rows(["a"], [[1]]) + json.rows(["a"], [[2]]) + json.footer();
    expect(JSON.parse(text)).toEqual([{ a: 1 }, { a: 2 }]);
  });
  it("cannot be broken out of on MySQL with a backslash", () => {
    const text = sqlTextFor("mysql").text("\\'); DROP TABLE users; -- ");
    // \\ is a literal backslash and '' a literal quote, so the string only ends at the last quote.
    expect(text).toBe("'\\\\''); DROP TABLE users; -- '");
  });
  it("writes bytes in each engine's own form", () => {
    expect(sqlTextFor("postgres").bytes("00ff")).toBe("'\\x00ff'");
    expect(sqlTextFor("mssql").bytes("00ff")).toBe("0x00ff");
    expect(sqlTextFor("mysql").bytes("00ff")).toBe("X'00ff'");
  });
  it("does not shorten values in SQL, and escapes quotes", () => {
    const long = "x'".repeat(400);
    const line = exporterFor("sql", "t", sql).rows(["a"], [[long]]);
    expect(line).toContain(long.replaceAll("'", "''"));
  });
});

describe("edited values", () => {
  it("never rounds a long number typed over a number", () => {
    expect(parseEdited("9007199254740993", 5, false)).toBe("9007199254740993");
    expect(parseEdited("6", 5, false)).toBe(6);
  });
  it("keeps JSON valid", () => {
    expect(parseEdited('{"a":1}', { a: 2 }, false)).toEqual({ a: 1 });
    expect(() => parseEdited("{nope", { a: 2 }, false)).toThrow();
  });
  it("types new values only on engines that keep types", () => {
    expect(parseEdited("5", null, true)).toBe(5);
    expect(parseEdited("5", null, false)).toBe("5");
    expect(parseEdited('{"a":1}', null, true)).toEqual({ a: 1 });
  });
  it("leaves text alone when it would not print back exactly", () => {
    expect(inferValue("007")).toBe("007");
    expect(inferValue("9007199254740993")).toBe("9007199254740993");
    expect(inferValue("1.50")).toBe("1.50");
    expect(inferValue("true")).toBe(true);
  });
});
