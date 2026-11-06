import type { Filter, SavedView, Sort } from "./contracts";

// Raw column positions in display order. Rows, cut cells and keys keep raw positions, so hiding or moving
// a column changes only what is drawn and never which cell or row an action reaches.
export function visiblePositions(names: string[], view: Pick<SavedView, "hiddenColumns" | "columnOrder">): number[] {
  const known = view.columnOrder.filter((name, index) => names.includes(name) && view.columnOrder.indexOf(name) === index);
  const ordered = [...known, ...names.filter((name) => !known.includes(name))];
  const shown = ordered.filter((name) => !view.hiddenColumns.includes(name)).map((name) => names.indexOf(name));
  // A saved view can hide every column that still exists, once the table has changed.
  return shown.length > 0 ? shown : names.map((_, index) => index);
}

// On catalog engines a sort or filter on a missing column would stop the table opening, so it is dropped.
export function dropMissingColumns(names: string[], sort: Sort | null, filters: Filter[]): { sort: Sort | null; filters: Filter[]; dropped: string[] } {
  const dropped = new Set<string>();
  if (sort && !names.includes(sort.column)) dropped.add(sort.column);
  for (const filter of filters) if (!names.includes(filter.column)) dropped.add(filter.column);
  return { sort: sort && names.includes(sort.column) ? sort : null, filters: filters.filter((filter) => names.includes(filter.column)), dropped: [...dropped] };
}
