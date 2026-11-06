import type { Filter, ObjectDetails } from "./contracts";

type ForeignKey = ObjectDetails["foreignKeys"][number];

// Filters that open the row a foreign key points at, or null when there is nowhere to go: an unknown
// target, a null in any column, or a value with no exact text form, such as bytes.
export function jumpFilters(key: ForeignKey, valueOf: (column: string) => unknown): Filter[] | null {
  if (!key.targetTable || key.columns.length === 0 || key.columns.length !== key.targetColumns.length) return null;
  const filters: Filter[] = [];
  for (const [index, column] of key.columns.entries()) {
    const value = valueOf(column);
    if (value === null || value === undefined || typeof value === "object") return null;
    filters.push({ column: key.targetColumns[index] as string, op: "eq", value: String(value) });
  }
  return filters;
}
