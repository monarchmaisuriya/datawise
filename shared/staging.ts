import type { RowKey, StagedEdit } from "./contracts";

export interface StagedRow {
  key: RowKey;
  deleted: boolean;
  original: Record<string, unknown>;
  changes: Record<string, unknown>;
}
export type StagedRows = ReadonlyMap<string, StagedRow>;

export function rowId(key: RowKey): string {
  return JSON.stringify(key);
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

// Edits to one row merge, and each column keeps the first value the user saw. So a batch holds one
// operation per row, whatever order the edits were made in.
export function stageCell(rows: StagedRows, key: RowKey, column: string, seen: unknown, value: unknown): StagedRows {
  if (Object.keys(key).includes(column)) throw new Error(`The key column ${column} cannot be changed with pending edits. Open the row and save it on its own.`);
  const next = new Map(rows);
  const id = rowId(key);
  const row = next.get(id) ?? { key, deleted: false, original: {}, changes: {} };
  const before = Object.keys(row.original).includes(column) ? row.original[column] : seen;
  const original = { ...row.original, [column]: before };
  const changes = { ...row.changes, [column]: value };
  if (same(before, value)) {
    delete original[column];
    delete changes[column];
  }
  if (Object.keys(changes).length === 0 && !row.deleted) next.delete(id);
  else next.set(id, { ...row, original, changes });
  return next;
}

// seen is the row's whole values as read. A value already pending keeps the first one the user saw.
export function stageDelete(rows: StagedRows, targets: { key: RowKey; seen: Record<string, unknown> }[]): StagedRows {
  const next = new Map(rows);
  for (const { key, seen } of targets) {
    const id = rowId(key);
    const row = next.get(id);
    next.set(id, { key, changes: row?.changes ?? {}, deleted: true, original: { ...seen, ...row?.original } });
  }
  return next;
}

export function toEdits(rows: StagedRows): StagedEdit[] {
  return [...rows.values()].map((row) => (row.deleted ? { kind: "delete" as const, key: row.key, original: row.original } : { kind: "update" as const, key: row.key, original: row.original, changes: row.changes }));
}
