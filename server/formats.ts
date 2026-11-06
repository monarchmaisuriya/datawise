import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { once } from "node:events";
import { Readable } from "node:stream";
import { BYTES_TAG, type ExportFormat, type ImportFormat, type ImportSource } from "../shared/contracts";
import type { EngineId } from "../shared/engines";
import { toCell } from "./cells";
import { loadDriver } from "./drivers";
import { renderLiteral } from "./adapters/sql-base";

type Record_ = Record<string, unknown>;

function openSource(source: ImportSource): Readable {
  return "path" in source ? createReadStream(source.path) : Readable.from([source.text]);
}

// Records one at a time, so a large file does not load into memory. JSON arrays are parsed whole: a
// streaming JSON parser would be a further dependency for a format that is rarely very large.
export async function* readRecords(source: ImportSource, format: ImportFormat): AsyncGenerator<Record_> {
  if (format === "csv" || format === "tsv") {
    const { parse } = await loadDriver<typeof import("csv-parse")>("csv-parse");
    const parser = openSource(source).pipe(parse({ columns: true, delimiter: format === "tsv" ? "\t" : ",", bom: true, skip_empty_lines: true, relax_column_count: false }));
    for await (const record of parser) yield record as Record_;
    return;
  }
  if (format === "ndjson") {
    const { createInterface } = await import("node:readline");
    let line = 0;
    for await (const text of createInterface({ input: openSource(source), crlfDelay: Infinity })) {
      line += 1;
      if (text.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`Line ${line} is not valid JSON.`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Line ${line} is not a JSON object.`);
      yield parsed as Record_;
    }
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of openSource(source)) chunks.push(Buffer.from(chunk as Buffer));
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const [index, item] of list.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`Item ${index + 1} is not a JSON object.`);
    yield item as Record_;
  }
}

function plainCell(value: unknown): string {
  const cell = toCell(value);
  if (cell === null) return "";
  if (typeof cell === "object") {
    const bytes: unknown = Reflect.get(cell, BYTES_TAG);
    return typeof bytes === "string" ? bytes : JSON.stringify(cell);
  }
  return String(cell);
}

function csvCell(text: string, delimiter: string): string {
  // A cell a spreadsheet would run as a formula gets a leading quote mark, so an export cannot carry
  // an active formula from the database into someone's spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
  return safe.includes(delimiter) || /["\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export interface Exporter {
  header(columns: string[]): string;
  rows(columns: string[], rows: unknown[][]): string;
  footer(): string;
}

// How one engine writes names, text and bytes in SQL. These differ enough that a value written the wrong
// way can run as code: MySQL reads a backslash as an escape, so \' ends a string it looks like it stays in.
export interface SqlText {
  quote(name: string): string;
  text(value: string): string;
  bytes(hex: string): string;
}

const ansiText = (value: string) => `'${value.replaceAll("'", "''")}'`;
const backslashText = (value: string) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''").replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("\0", "\\0")}'`;
const ansiName = (name: string) => `"${name.replaceAll('"', '""')}"`;
const tickName = (name: string) => `\`${name.replaceAll("`", "``")}\``;

export function sqlTextFor(engine: EngineId): SqlText {
  switch (engine) {
    case "mysql":
      return { quote: tickName, text: backslashText, bytes: (hex) => `X'${hex}'` };
    case "clickhouse":
      return { quote: tickName, text: (value) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`, bytes: (hex) => `unhex('${hex}')` };
    case "mssql":
      return { quote: (name) => `[${name.replaceAll("]", "]]")}]`, text: (value) => `N${ansiText(value)}`, bytes: (hex) => `0x${hex}` };
    case "postgres":
      return { quote: ansiName, text: ansiText, bytes: (hex) => `'\\x${hex}'` };
    case "oracle":
      return { quote: ansiName, text: ansiText, bytes: (hex) => `HEXTORAW('${hex}')` };
    default:
      return { quote: ansiName, text: ansiText, bytes: (hex) => `X'${hex}'` };
  }
}

export function exporterFor(format: ExportFormat, tableName: string, sql: SqlText): Exporter {
  switch (format) {
    case "csv":
    case "tsv": {
      const delimiter = format === "tsv" ? "\t" : ",";
      return {
        header: (columns) => `${columns.map((name) => csvCell(name, delimiter)).join(delimiter)}\n`,
        rows: (_columns, rows) => rows.map((row) => `${row.map((cell) => csvCell(plainCell(cell), delimiter)).join(delimiter)}\n`).join(""),
        footer: () => "",
      };
    }
    case "ndjson": {
      const line = (columns: string[], row: unknown[]) => `${JSON.stringify(Object.fromEntries(columns.map((name, index) => [name, toCell(row[index])])))}\n`;
      return { header: () => "", rows: (columns, rows) => rows.map((row) => line(columns, row)).join(""), footer: () => "" };
    }
    case "json": {
      let first = true;
      return {
        header: () => "[\n",
        rows: (columns, rows) =>
          rows
            .map((row) => {
              const text = `${first ? "" : ",\n"}${JSON.stringify(Object.fromEntries(columns.map((name, index) => [name, toCell(row[index])])))}`;
              first = false;
              return text;
            })
            .join(""),
        footer: () => "\n]\n",
      };
    }
    case "sql":
      return {
        header: () => "",
        rows: (columns, rows) => rows.map((row) => `INSERT INTO ${sql.quote(tableName)} (${columns.map(sql.quote).join(", ")}) VALUES (${row.map((cell) => renderSqlValue(toCell(cell), sql)).join(", ")});\n`).join(""),
        footer: () => "",
      };
  }
}

// Unlike the preview renderer, nothing here is shortened: this text is meant to be run.
function renderSqlValue(cell: unknown, sql: SqlText): string {
  if (cell !== null && typeof cell === "object") {
    const bytes: unknown = Reflect.get(cell, BYTES_TAG);
    if (typeof bytes === "string") return sql.bytes(Buffer.from(bytes, "base64").toString("hex"));
    return sql.text(JSON.stringify(cell));
  }
  if (typeof cell === "string") return sql.text(cell);
  return renderLiteral(cell);
}

export async function writeChunk(stream: WriteStream, text: string): Promise<void> {
  if (text !== "" && !stream.write(text)) await once(stream, "drain");
}

export function openOutput(path: string): WriteStream {
  // wx: never overwrite, including a leftover .partial from another export.
  return createWriteStream(path, { flags: "wx", mode: 0o600 });
}
