import { BYTES_TAG } from "../shared/contracts";

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

export interface FinishedRows {
  rows: unknown[][];
  cutCells: [number, number][];
  truncated: boolean;
}

// Applies the cell and response limits. Cut cells are listed so the client can refuse to write them.
export function finishRows(raw: unknown[][], rowLimit: number | null = null, cellLimit = CELL_LIMIT): FinishedRows {
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
      const cell = toCell(rawCell);
      const text = typeof cell === "string" ? cell : cell !== null && typeof cell === "object" ? JSON.stringify(cell) : "";
      if (text.length <= cellLimit) {
        size += text.length + 8;
        return cell;
      }
      cutCells.push([rowIndex, columnIndex]);
      size += cellLimit + 8;
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
