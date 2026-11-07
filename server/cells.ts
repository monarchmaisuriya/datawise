import { BYTES_SIZE, BYTES_TAG, bytesSize } from "../shared/contracts";

export const CELL_LIMIT = 16 * 1024;
export const RESPONSE_LIMIT = 32 * 1024 * 1024;

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

// Turns a driver value into something JSON can carry without changing what it means. A JavaScript
// number cannot hold every bigint, so bigints travel as text, and a client never does math on them.
export function toCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
    case "object":
      break;
    default:
      return String(value);
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? String(value) : value.toISOString();
  if (isBytes(value)) return { [BYTES_TAG]: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(toCell);
  const toJson: unknown = Reflect.get(value, "toJSON");
  if (typeof toJson === "function") return toCell(Reflect.apply(toJson, value, []));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toCell(item)]));
}

// The reverse for values coming back from an edit.
export function fromCell(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const bytes: unknown = Reflect.get(value, BYTES_TAG);
    if (typeof bytes === "string" && Object.keys(value).length === 1) return Buffer.from(bytes, "base64");
  }
  return value;
}

// For a reader that must get a size and no content, even inside an array or a document.
function hideBytes(value: unknown): unknown {
  if (isBytes(value)) return `<${value.length} bytes>`;
  if (Array.isArray(value)) return value.map(hideBytes);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, hideBytes(item)]));
  return value;
}

export interface FinishedRows {
  rows: unknown[][];
  cutCells: [number, number][];
  truncated: boolean;
}

// Positions of the named columns, for finishRows' columns to keep whole.
export function positionsOf(names: readonly string[], wanted: readonly string[]): number[] {
  return wanted.map((name) => names.indexOf(name)).filter((position) => position !== -1);
}

// Applies the cell and response limits. Cut cells are listed so the client can refuse to write them.
// Key columns are kept whole: a row's key is how a later write finds that row, and a cut key names a different one.
export function finishRows(raw: unknown[][], rowLimit: number | null = null, cellLimit = CELL_LIMIT, bytesAsSize = false, keepWhole: readonly number[] = []): FinishedRows {
  const rows: unknown[][] = [];
  const cutCells: [number, number][] = [];
  let size = 0;
  let truncated = false;
  for (const [rowIndex, rawRow] of raw.entries()) {
    if (rowLimit !== null && rowIndex >= rowLimit) {
      truncated = true;
      break;
    }
    const row = rawRow.map((rawCell, columnIndex) => {
      const cell = toCell(bytesAsSize ? hideBytes(rawCell) : rawCell);
      const text = typeof cell === "string" ? cell : cell !== null && typeof cell === "object" ? JSON.stringify(cell) : "";
      if (text.length <= cellLimit || keepWhole.includes(columnIndex)) {
        size += text.length + 8;
        return cell;
      }
      cutCells.push([rowIndex, columnIndex]);
      size += cellLimit + 8;
      // Binary stays binary when cut: the start of its bytes and its whole size, never a piece of JSON text.
      const base64 = cell !== null && typeof cell === "object" ? Reflect.get(cell, BYTES_TAG) : undefined;
      if (typeof base64 === "string" && cell !== null && typeof cell === "object") return { [BYTES_TAG]: base64.slice(0, Math.max(4, Math.floor(cellLimit / 4) * 4)), [BYTES_SIZE]: bytesSize(cell) };
      return text.slice(0, cellLimit);
    });
    if (size > RESPONSE_LIMIT) {
      truncated = true;
      break;
    }
    rows.push(row);
  }
  return { rows, cutCells: cutCells.filter(([rowIndex]) => rowIndex < rows.length), truncated };
}
