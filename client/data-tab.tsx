import { Modal } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Text, View } from "react-native";
import type { ConnectionView, Filter, ObjectRef, RowKey, RowPage, Sort } from "../shared/contracts";
import { ENGINES, FILTER_LABELS, type FilterOp } from "../shared/engines";
import { Grid } from "./grid";
import { Btn, errorText, Field, Message, Select, useApi, useConfirm, useGuardedRun, useUi, waitForJob } from "./kit";
import { RowForm, type RowFormMode } from "./row-form";
import { ExportModal, ImportModal } from "./transfer";

const PAGE_SIZES = [50, 100, 500, 1000];

function keyOf(page: RowPage, row: unknown[]): RowKey {
  return Object.fromEntries(page.keyColumns.map((name) => [name, row[page.columns.findIndex((column) => column.name === name)]]));
}

export function DataTab({ connection, refObject }: { connection: ConnectionView; refObject: ObjectRef }) {
  const ui = useUi();
  const api = useApi();
  const client = useQueryClient();
  const ask = useConfirm();
  const guarded = useGuardedRun();
  const info = ENGINES[connection.engine];
  const [limit, setLimit] = useState(100);
  // Earlier positions, so Previous works on engines whose position is an opaque token.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [sort, setSort] = useState<Sort | null>(null);
  const [filters, setFilters] = useState<Filter[]>([]);
  // By key, not by position: a refresh can move rows, and a position would then name a different row.
  const [selected, setSelected] = useState<ReadonlyMap<string, RowKey>>(new Map());
  const [form, setForm] = useState<RowFormMode | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [count, setCount] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const cursor = cursors[cursors.length - 1] ?? null;
  const queryKey = ["datawise", "rows", refObject, limit, cursor, sort, filters];
  const page = useQuery({ queryKey, queryFn: () => api.readRows({ ref: refObject, query: { limit, cursor, sort, filters } }), retry: false });
  const data = page.data;
  // Kept after a failure, so a filter that the database refused can still be opened and corrected.
  const knownColumns = useRef<string[]>([]);
  if (data) knownColumns.current = data.columns.map((column) => column.name);

  const resetPaging = () => {
    setCursors([null]);
    setSelected(new Map());
    setCount(null);
  };
  const refresh = () => {
    setSelected(new Map());
    setCount(null);
    void client.invalidateQueries({ queryKey: ["datawise", "rows", refObject] });
  };
  const toggleSort = (column: string) => {
    resetPaging();
    setSort((current) => (current?.column !== column ? { column, descending: false } : current.descending ? null : { column, descending: true }));
  };
  const toggle = (index: number) => {
    const row = data?.rows[index];
    if (!data || !row) return;
    const key = keyOf(data, row);
    const id = JSON.stringify(key);
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(id)) next.delete(id);
      else next.set(id, key);
      return next;
    });
  };

  const countRows = async () => {
    setCount("counting…");
    try {
      const job = await waitForJob(api, await api.countRows({ ref: refObject, filters }));
      setCount(job.status === "done" ? `${job.count ?? 0} rows` : (job.error ?? "could not count"));
    } catch (error) {
      setCount(errorText(error));
    }
  };

  const removeSelected = async () => {
    if (!data) return;
    setActionError(null);
    const keys = [...selected.values()];
    try {
      // A bulk delete always asks once, whatever the safety mode, because the cost of a slip is high.
      const sure = await ask({ title: `Delete ${keys.length} row${keys.length === 1 ? "" : "s"}?`, preview: JSON.stringify(keys.slice(0, 10), null, 1), actionLabel: "Delete" });
      if (!sure) return;
      const job = await guarded(api, () => api.writeRows({ ref: refObject, op: { kind: "delete", keys }, confirmed: true }));
      if (job && job.status !== "done") throw new Error(job.error ?? `The delete ended as ${job.status}.`);
      refresh();
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const selectedIndexes = new Set((data?.rows ?? []).flatMap((row, index) => (data && selected.has(JSON.stringify(keyOf(data, row))) ? [index] : [])));
  const canSelect = data !== undefined && data.keyColumns.length > 0 && info.canEditRows && connection.safety !== "read-only";
  // A position is a row offset on most engines. On the rest it is an opaque token, with no number to show.
  const start = cursor === null ? 0 : /^\d+$/.test(cursor) ? Number(cursor) : null;
  const rowsLabel = data ? `${data.rows.length === 0 ? "No rows" : start !== null ? `Rows ${start + 1}–${start + data.rows.length}` : `${data.rows.length} rows`}${data.truncated ? " (page cut for size; Next continues)" : ""}` : "";

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={ui.toolbar}>
        <Btn icon="RefreshCw" onPress={refresh} />
        <Btn icon="ListFilter" label={filters.length > 0 ? `Filter (${filters.length})` : "Filter"} onPress={() => setFilterOpen(true)} />
        {info.canInsertRows && connection.safety !== "read-only" ? <Btn icon="Plus" label="Row" onPress={() => setForm({ kind: "insert" })} /> : null}
        {selected.size > 0 ? <Btn icon="Trash2" label={`Delete ${selected.size}`} kind="danger" onPress={() => void removeSelected()} /> : null}
        <Btn icon="Hash" label={count ?? "Count"} onPress={() => void countRows()} />
        <Btn icon="Upload" label="Import" disabled={connection.safety === "read-only"} onPress={() => setImporting(true)} />
        <Btn icon="Download" label="Export" onPress={() => setExporting(true)} />
      </View>
      {actionError ? <View style={{ paddingHorizontal: 12 }}><Message kind="error" text={actionError} /></View> : null}
      {page.error ? <View style={{ padding: 12 }}><Message kind="error" text={errorText(page.error)} /></View> : null}
      {data && data.keyColumns.length === 0 && data.keyReason ? <View style={{ paddingHorizontal: 12 }}><Message kind="note" text={data.keyReason} /></View> : null}
      {page.isLoading ? <View style={{ padding: 12 }}><Message kind="note" text="Loading…" /></View> : null}
      {data ? (
        <Grid
          columns={data.columns}
          rows={data.rows}
          cutCells={data.cutCells}
          sort={sort}
          onSort={info.canSort ? toggleSort : undefined}
          selected={canSelect ? selectedIndexes : undefined}
          onToggle={toggle}
          onRowPress={(index) => {
            const row = data.rows[index];
            if (row) setForm({ kind: "edit", key: keyOf(data, row), row, hasCutCells: data.cutCells.some(([rowIndex]) => rowIndex === index) });
          }}
        />
      ) : null}
      {/* Keeps the paging row at the bottom when there is no grid above it. */}
      {data ? null : <View style={{ flex: 1 }} />}
      <View style={[ui.toolbar, { borderBottomWidth: 0, borderTopWidth: 1, borderTopColor: ui.colors.border, justifyContent: "space-between" }]}>
        <Text style={ui.muted}>{rowsLabel}</Text>
        <View style={ui.row}>
          <Select
            label="Rows per page"
            value={String(limit)}
            options={PAGE_SIZES.map((size) => ({ label: `${size} per page`, value: String(size) }))}
            onChange={(next) => {
              setLimit(Number(next));
              resetPaging();
            }}
          />
          <Btn
            icon="ChevronLeft"
            disabled={cursors.length <= 1}
            onPress={() => {
              setCursors((current) => current.slice(0, -1));
              setSelected(new Map());
            }}
          />
          <Btn
            icon="ChevronRight"
            disabled={!data?.nextCursor}
            onPress={() => {
              const next = data?.nextCursor;
              if (next) {
                setCursors((current) => [...current, next]);
                setSelected(new Map());
              }
            }}
          />
        </View>
      </View>
      {form && data ? (
        <RowForm key={form.kind === "edit" ? JSON.stringify(form.key) : "new"} connection={connection} refObject={refObject} columns={data.columns} keyColumns={data.keyColumns} keyReason={data.keyReason} mode={form} onClose={() => setForm(null)} onChanged={refresh} onDuplicate={(values) => setForm({ kind: "insert", values: Object.fromEntries(Object.entries(values).filter(([name]) => !data.keyColumns.includes(name))) })} />
      ) : null}
      {filterOpen ? (
        <FilterModal
          columns={knownColumns.current}
          ops={info.filterOps}
          value={filters}
          onClose={() => setFilterOpen(false)}
          onApply={(next) => {
            setFilters(next);
            resetPaging();
            setFilterOpen(false);
          }}
        />
      ) : null}
      {exporting ? <ExportModal connection={connection} source={{ kind: "object", ref: refObject, sort, filters }} name={refObject.name} onClose={() => setExporting(false)} /> : null}
      {importing ? <ImportModal connection={connection} refObject={refObject} columns={data?.columns.map((column) => column.name) ?? []} onClose={() => setImporting(false)} onDone={refresh} /> : null}
    </View>
  );
}

function FilterModal({ columns, ops, value, onClose, onApply }: { columns: string[]; ops: FilterOp[]; value: Filter[]; onClose: () => void; onApply: (filters: Filter[]) => void }) {
  const ui = useUi();
  const [rows, setRows] = useState<Filter[]>(value.length > 0 ? value : [{ column: columns[0] ?? "", op: ops[0] ?? "eq", value: "" }]);
  const patch = (index: number, change: Partial<Filter>) => setRows((current) => current.map((row, position) => (position === index ? { ...row, ...change } : row)));
  return (
    <Modal title="Filter" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        {rows.map((row, index) => (
          <View key={index} style={[ui.card, { gap: 6 }]}>
            <View style={ui.row}>
              <View style={{ flex: 1 }}>
                <Select label="Column" value={row.column} options={columns.map((name) => ({ label: name, value: name }))} onChange={(column) => patch(index, { column })} />
              </View>
              <View style={{ flex: 1 }}>
                <Select label="Condition" value={row.op} options={ops.map((op) => ({ label: FILTER_LABELS[op], value: op }))} onChange={(op) => patch(index, { op: op as FilterOp })} />
              </View>
              <Btn icon="X" onPress={() => setRows((current) => current.filter((_, position) => position !== index))} />
            </View>
            {row.op !== "null" && row.op !== "notnull" ? <Field label="Value" value={row.value} onChangeText={(next) => patch(index, { value: next })} mono /> : null}
          </View>
        ))}
        <View style={[ui.row, { justifyContent: "space-between" }]}>
          <Btn icon="Plus" label="Another" onPress={() => setRows((current) => [...current, { column: columns[0] ?? "", op: ops[0] ?? "eq", value: "" }])} />
          <View style={ui.row}>
            <Btn label="Clear" onPress={() => onApply([])} />
            <Btn label="Apply" kind="primary" onPress={() => onApply(rows.filter((row) => row.column !== ""))} />
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}
