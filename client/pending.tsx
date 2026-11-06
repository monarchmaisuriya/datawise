import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ObjectRef, RowKey } from "../shared/contracts";
import { stageCell, stageDelete, type StagedRows } from "../shared/staging";

function tableId(ref: ObjectRef): string {
  return JSON.stringify([ref.connectionId, ref.database ?? null, ref.schema ?? null, ref.name]);
}

const NONE: StagedRows = new Map();

// Held above the tabs, so pending edits survive moving between tabs and tables. They do not survive a
// reload, and they are never sent until the person reviews them.
function usePendingStore() {
  const [tables, setTables] = useState<ReadonlyMap<string, StagedRows>>(new Map());
  const change = useCallback((ref: ObjectRef, update: (rows: StagedRows) => StagedRows) => {
    setTables((current) => {
      const next = new Map(current);
      const rows = update(current.get(tableId(ref)) ?? NONE);
      if (rows.size === 0) next.delete(tableId(ref));
      else next.set(tableId(ref), rows);
      return next;
    });
  }, []);
  return useMemo(
    () => ({
      total: [...tables.values()].reduce((sum, rows) => sum + rows.size, 0),
      rowsOf: (ref: ObjectRef) => tables.get(tableId(ref)) ?? NONE,
      setCell: (ref: ObjectRef, key: RowKey, column: string, seen: unknown, value: unknown) => change(ref, (rows) => stageCell(rows, key, column, seen, value)),
      deleteRows: (ref: ObjectRef, targets: { key: RowKey; seen: Record<string, unknown> }[]) => change(ref, (rows) => stageDelete(rows, targets)),
      clear: (ref: ObjectRef) => change(ref, () => NONE),
      // Staging makes a new object for a row it changes, so this keeps anything staged after the commit began.
      removeCommitted: (ref: ObjectRef, committed: StagedRows) => change(ref, (rows) => new Map([...rows].filter(([id, row]) => committed.get(id) !== row))),
      clearAll: () => setTables(new Map()),
    }),
    [tables, change],
  );
}

export type PendingStore = ReturnType<typeof usePendingStore>;
const PendingContext = createContext<PendingStore | null>(null);

export function PendingProvider({ onCount, children }: { onCount?: (count: number) => void; children: ReactNode }) {
  const store = usePendingStore();
  useEffect(() => onCount?.(store.total), [onCount, store.total]);
  return <PendingContext.Provider value={store}>{children}</PendingContext.Provider>;
}

export function usePending(): PendingStore {
  const store = useContext(PendingContext);
  if (!store) throw new Error("Datawise pending edits used outside their provider");
  return store;
}
