import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { ColumnInfo, ConnectionView, Filter, ObjectDetails, ObjectRef, RowKey, RowPage, SavedFilter, SavedView, Sort } from "../shared/contracts";
import { ENGINES, FILTER_LABELS, type FilterOp } from "../shared/engines";
import { toMarkdownTable } from "../shared/markdown";
import { PAGE_SIZES } from "../shared/preferences";
import { rowId, toEdits } from "../shared/staging";
import { parseEdited } from "../shared/values";
import { dropMissingColumns, visiblePositions } from "../shared/view-columns";
import { Grid } from "./grid";
import { Btn, cellText, Chip, errorText, Field, isBytes, Message, Modal, Select, useApi, useConfirm, useGuardedRun, useUi, waitForJob } from "./kit";
import { usePending } from "./pending";
import { usePreferences } from "./preferences";
import { RowForm, type RowFormMode } from "./row-form";
import { ExportModal, ImportModal } from "./transfer";

function keyOf(page: RowPage, row: unknown[]): RowKey {
  return Object.fromEntries(page.keyColumns.map((name) => [name, row[page.columns.findIndex((column) => column.name === name)]]));
}

export interface JumpTarget {
  key: ObjectDetails["foreignKeys"][number];
  filters: Filter[];
}

const NO_VIEW: SavedView = { hiddenColumns: [], columnOrder: [], sort: null, filtersInUse: [], filters: [] };

// Loads the saved view and, on catalog engines, the table's columns before the first read, so a stale view
// can be corrected before it can stop the table opening.
export function DataTab({ connection, refObject, initialFilters, onJump }: { connection: ConnectionView; refObject: ObjectRef; initialFilters?: Filter[]; onJump?: (target: JumpTarget) => void }) {
  const api = useApi();
  const info = ENGINES[connection.engine];
  const view = useQuery({ queryKey: ["datawise", "view", refObject], queryFn: () => api.getView(refObject), retry: false, gcTime: 0 });
  const details = useQuery({ queryKey: ["datawise", "describe", refObject], queryFn: () => api.describeObject(refObject), enabled: info.catalogSchema, retry: false });
  if (view.isLoading || (info.catalogSchema && details.isLoading)) {
    return (
      <View style={{ padding: 12 }}>
        <Message kind="note" text="Loading…" />
      </View>
    );
  }
  return <DataGrid connection={connection} refObject={refObject} saved={view.data ?? NO_VIEW} canSaveView={view.isSuccess} details={details.data ?? null} initialFilters={initialFilters} onJump={onJump} />;
}

function DataGrid({ connection, refObject, saved, canSaveView, details, initialFilters, onJump }: { connection: ConnectionView; refObject: ObjectRef; saved: SavedView; canSaveView: boolean; details: ObjectDetails | null; initialFilters?: Filter[]; onJump?: (target: JumpTarget) => void }) {
  const ui = useUi();
  const api = useApi();
  const client = useQueryClient();
  const ask = useConfirm();
  const guarded = useGuardedRun();
  const toast = useToast();
  const pending = usePending();
  const preferences = usePreferences();
  const info = ENGINES[connection.engine];
  const staged = pending.rowsOf(refObject);
  const opening = useMemo(() => {
    const filtersToUse = initialFilters ?? saved.filtersInUse;
    return details ? dropMissingColumns(details.columns.map((column) => column.name), saved.sort, filtersToUse) : { sort: saved.sort, filters: filtersToUse, dropped: [] };
    // Only what the table opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [limit, setLimit] = useState<number>(preferences.rowsPerPage);
  // Earlier positions, so Previous works on engines whose position is an opaque token.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [sort, setSort] = useState<Sort | null>(opening.sort);
  const [filters, setFilters] = useState<Filter[]>(opening.filters);
  const [hiddenColumns, setHiddenColumns] = useState(saved.hiddenColumns);
  const [columnOrder, setColumnOrder] = useState(saved.columnOrder);
  const [savedFilters, setSavedFilters] = useState(saved.filters);
  // By key, not by position: a refresh can move rows, and a position would then name a different row.
  const [selected, setSelected] = useState<ReadonlyMap<string, { key: RowKey; seen: Record<string, unknown> }>>(new Map());
  const [form, setForm] = useState<RowFormMode | null>(null);
  // Holds the row itself, not its position: a refetch while this is open can put another row at that position.
  const [cellEdit, setCellEdit] = useState<{ key: RowKey; column: ColumnInfo; stored: unknown; current: unknown } | null>(null);
  // Coming back to a table with pending edits continues them.
  const [editingCells, setEditingCells] = useState(staged.size > 0);
  const [filterOpen, setFilterOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [count, setCount] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [droppedNote, setDroppedNote] = useState(opening.dropped);
  const [committing, setCommitting] = useState(false);

  // Saved when it changes, and not on opening. A jump's filter is for this visit, so the saved one stays.
  const viewNow: SavedView = useMemo(() => {
    const fromJump = initialFilters !== undefined && JSON.stringify(filters) === JSON.stringify(initialFilters);
    return { hiddenColumns, columnOrder, sort, filtersInUse: fromJump ? saved.filtersInUse : filters, filters: savedFilters };
    // saved and initialFilters are what the table opened with, and do not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenColumns, columnOrder, sort, filters, savedFilters]);
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) {
      firstView.current = false;
      return;
    }
    // A view that could not be read must not be replaced with one built from nothing.
    if (!canSaveView) return;
    api.saveView({ ref: refObject, view: viewNow }).catch((error: unknown) => setActionError(`This view could not be saved: ${errorText(error)}`));
    // The api object is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewNow]);

  const cursor = cursors[cursors.length - 1] ?? null;
  const queryKey = ["datawise", "rows", refObject, limit, cursor, sort, filters];
  const page = useQuery({ queryKey, queryFn: () => api.readRows({ ref: refObject, query: { limit, cursor, sort, filters } }), retry: false });
  const data = page.data;
  // Kept after a failure, so a filter that the database refused can still be opened and corrected.
  const knownColumns = useRef<string[]>([]);
  if (data) knownColumns.current = data.columns.map((column) => column.name);
  const names = useMemo(() => data?.columns.map((column) => column.name) ?? [], [data]);
  const visible = useMemo(() => visiblePositions(names, { hiddenColumns, columnOrder }), [names, hiddenColumns, columnOrder]);

  // Shown as they will be. Everything that acts on a row still reads data.rows, the rows as stored.
  const overlay = useMemo(() => {
    const editedCells = new Map<number, Set<number>>();
    const deletedRows = new Set<number>();
    const rows = (data?.rows ?? []).map((row, index) => {
      if (!data) return row;
      const entry = staged.get(rowId(keyOf(data, row)));
      if (!entry) return row;
      if (entry.deleted) deletedRows.add(index);
      const next = [...row];
      const cells = new Set<number>();
      for (const [name, value] of Object.entries(entry.changes)) {
        const position = names.indexOf(name);
        if (position !== -1) {
          next[position] = value;
          cells.add(position);
        }
      }
      editedCells.set(index, cells);
      return next;
    });
    return { rows, editedCells, deletedRows };
  }, [data, staged, names]);

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
    // Whole values only. A cut one is not what is stored, so it could never compare equal.
    const seen = Object.fromEntries(data.columns.flatMap((column, position) => (data.cutCells.some(([rowIndex, cutPosition]) => rowIndex === index && cutPosition === position) ? [] : [[column.name, row[position] ?? null]])));
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(id)) next.delete(id);
      else next.set(id, { key, seen });
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
    const keys = [...selected.values()].map((item) => item.key);
    if (editingCells) {
      pending.deleteRows(refObject, [...selected.values()]);
      setSelected(new Map());
      return;
    }
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

  // Always reviewed, whatever the write mode: pending edits can be old, and the review is the point.
  const commit = async () => {
    setActionError(null);
    setCommitting(true);
    const committed = staged;
    const edits = toEdits(committed);
    try {
      const plan = await api.writeBatch({ ref: refObject, edits, dryRun: true, confirmed: false });
      if (plan.status !== "confirm") return;
      const sure = await ask({ title: `Commit ${edits.length} row${edits.length === 1 ? "" : "s"}?`, preview: plan.preview, reason: plan.reason, actionLabel: "Commit" });
      if (!sure) return;
      const job = await guarded(api, () => api.writeBatch({ ref: refObject, edits, dryRun: false, confirmed: true }));
      if (!job) return;
      if (job.status !== "done") throw new Error(job.error ?? `The commit ended as ${job.status}.`);
      pending.removeCommitted(refObject, committed);
      toast.show("Committed", { variant: "success" });
      refresh();
    } catch (error) {
      setActionError(errorText(error));
    } finally {
      setCommitting(false);
    }
  };

  const copyPage = () => {
    if (!data) return;
    void copyText(toMarkdownTable(names, data.rows, visible, data.cutCells)).then(
      () => toast.show(`Copied ${data.rows.length} row${data.rows.length === 1 ? "" : "s"}`, { variant: "success" }),
      () => toast.error("Could not copy."),
    );
  };

  const pressCell = (index: number, position: number) => {
    setActionError(null);
    const row = data?.rows[index];
    const column = data?.columns[position];
    if (!data || !row || !column) return;
    const cut = data.cutCells.some(([rowIndex, cutPosition]) => rowIndex === index && cutPosition === position);
    // These cannot be edited in place: a cut value is not whole, and a key must not change with others pending.
    if (cut || isBytes(row[position]) || column.generated) {
      setForm({ kind: "edit", key: keyOf(data, row), row, hasCutCells: data.cutCells.some(([rowIndex]) => rowIndex === index) });
    } else if (data.keyColumns.includes(column.name)) {
      setActionError(`The key column ${column.name} cannot be changed with pending edits. Open the row and save it on its own.`);
    } else setCellEdit({ key: keyOf(data, row), column, stored: row[position] ?? null, current: overlay.rows[index]?.[position] ?? null });
  };

  const selectedIndexes = new Set((data?.rows ?? []).flatMap((row, index) => (data && selected.has(JSON.stringify(keyOf(data, row))) ? [index] : [])));
  const canSelect = data !== undefined && data.keyColumns.length > 0 && info.canEditRows && connection.safety !== "read-only";
  const canStage = canSelect && info.transactionalEdits;
  // A position is a row offset on most engines. On the rest it is an opaque token, with no number to show.
  const start = cursor === null ? 0 : /^\d+$/.test(cursor) ? Number(cursor) : null;
  const rowsLabel = data ? `${data.rows.length === 0 ? "No rows" : start !== null ? `Rows ${start + 1}–${start + data.rows.length}` : `${data.rows.length} rows`}${data.truncated ? " (page cut for size; Next continues)" : ""}` : "";
  const elsewhere = pending.total - staged.size;

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={ui.toolbar}>
        <Btn icon="RefreshCw" onPress={refresh} />
        <Btn icon="ListFilter" label={filters.length > 0 ? `Filter (${filters.length})` : "Filter"} onPress={() => setFilterOpen(true)} />
        <Btn icon="Columns3" label={hiddenColumns.length > 0 ? `Columns (${hiddenColumns.length} hidden)` : "Columns"} disabled={!data} onPress={() => setColumnsOpen(true)} />
        {info.canInsertRows && connection.safety !== "read-only" ? <Btn icon="Plus" label="Row" onPress={() => setForm({ kind: "insert" })} /> : null}
        {canStage ? <Chip label="Edit cells" on={editingCells} onPress={() => setEditingCells((on) => !on)} /> : null}
        {selected.size > 0 ? <Btn icon="Trash2" label={editingCells ? `Mark ${selected.size} for delete` : `Delete ${selected.size}`} kind="danger" disabled={committing} onPress={() => void removeSelected()} /> : null}
        <Btn icon="Hash" label={count ?? "Count"} onPress={() => void countRows()} />
        <Btn icon="Upload" label="Import" disabled={connection.safety === "read-only"} onPress={() => setImporting(true)} />
        <Btn icon="Download" label="Export" onPress={() => setExporting(true)} />
        <Btn icon="ClipboardCopy" label="Copy as Markdown" disabled={!data || data.rows.length === 0} onPress={copyPage} />
      </View>
      {staged.size > 0 ? (
        <View style={[ui.toolbar, { backgroundColor: ui.colors.surface1 }]}>
          <Text style={ui.body}>
            {staged.size} row{staged.size === 1 ? "" : "s"} pending{elsewhere > 0 ? `, and ${elsewhere} in other tables` : ""}. Nothing is written until you commit.
          </Text>
          <Btn label={committing ? "Working…" : "Review and commit"} kind="primary" disabled={committing} onPress={() => void commit()} />
          <Btn label="Discard" disabled={committing} onPress={() => pending.clear(refObject)} />
        </View>
      ) : null}
      {droppedNote.length > 0 ? (
        <View style={[ui.row, { paddingHorizontal: 12 }]}>
          <Text style={[ui.muted, { flexShrink: 1 }]}>This table no longer has {droppedNote.join(", ")}, so the saved sort or filter on it was left out.</Text>
          <Btn icon="X" onPress={() => setDroppedNote([])} />
        </View>
      ) : null}
      {canSaveView ? null : <View style={{ paddingHorizontal: 12 }}><Message kind="warning" text="This table's saved view could not be read, so changes to columns, sort and filters are not being saved." /></View>}
      {actionError ? <View style={{ paddingHorizontal: 12 }}><Message kind="error" text={actionError} /></View> : null}
      {page.error ? <View style={{ padding: 12 }}><Message kind="error" text={errorText(page.error)} /></View> : null}
      {data && data.keyColumns.length === 0 && data.keyReason ? <View style={{ paddingHorizontal: 12 }}><Message kind="note" text={data.keyReason} /></View> : null}
      {page.isLoading ? <View style={{ padding: 12 }}><Message kind="note" text="Loading…" /></View> : null}
      {data ? (
        <Grid
          columns={data.columns}
          rows={overlay.rows}
          cutCells={data.cutCells}
          visible={visible}
          editedCells={overlay.editedCells}
          deletedRows={overlay.deletedRows}
          sort={sort}
          onSort={info.canSort ? toggleSort : undefined}
          selected={canSelect ? selectedIndexes : undefined}
          onToggle={toggle}
          onCellPress={editingCells && canStage && !committing ? pressCell : undefined}
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
        <RowForm
          key={form.kind === "edit" ? JSON.stringify(form.key) : "new"}
          connection={connection}
          refObject={refObject}
          columns={data.columns}
          keyColumns={data.keyColumns}
          keyReason={data.keyReason}
          mode={form}
          foreignKeys={details?.foreignKeys}
          onJump={
            onJump
              ? (key, jump) => {
                  setForm(null);
                  onJump({ key, filters: jump });
                }
              : undefined
          }
          onClose={() => setForm(null)}
          onChanged={refresh}
          onDuplicate={(values) => setForm({ kind: "insert", values: Object.fromEntries(Object.entries(values).filter(([name]) => !data.keyColumns.includes(name))) })}
        />
      ) : null}
      {cellEdit ? (
        <CellModal
          column={cellEdit.column}
          stored={cellEdit.stored}
          current={cellEdit.current}
          schemaless={info.schemaless}
          onClose={() => setCellEdit(null)}
          onStage={(value) => {
            pending.setCell(refObject, cellEdit.key, cellEdit.column.name, cellEdit.stored, value);
            setCellEdit(null);
          }}
        />
      ) : null}
      {filterOpen ? (
        <FilterModal
          columns={knownColumns.current}
          ops={info.filterOps}
          value={filters}
          saved={savedFilters}
          onSaved={setSavedFilters}
          onClose={() => setFilterOpen(false)}
          onApply={(next) => {
            setFilters(next);
            resetPaging();
            setFilterOpen(false);
          }}
        />
      ) : null}
      {columnsOpen ? (
        <ColumnsModal
          names={names}
          hidden={hiddenColumns}
          visible={visible}
          onClose={() => setColumnsOpen(false)}
          onChange={(nextHidden, nextOrder) => {
            setHiddenColumns(nextHidden);
            setColumnOrder(nextOrder);
          }}
        />
      ) : null}
      {exporting ? <ExportModal connection={connection} source={{ kind: "object", ref: refObject, sort, filters }} name={refObject.name} onClose={() => setExporting(false)} /> : null}
      {importing ? <ImportModal connection={connection} refObject={refObject} columns={data?.columns.map((column) => column.name) ?? []} onClose={() => setImporting(false)} onDone={refresh} /> : null}
    </View>
  );
}

function CellModal({ column, stored, current, schemaless, onClose, onStage }: { column: ColumnInfo; stored: unknown; current: unknown; schemaless: boolean; onClose: () => void; onStage: (value: unknown) => void }) {
  const ui = useUi();
  const [text, setText] = useState(current === null ? "" : cellText(current));
  const [isNull, setIsNull] = useState(current === null);
  const [error, setError] = useState<string | null>(null);
  const stage = () => {
    try {
      onStage(isNull ? null : parseEdited(text, stored, schemaless));
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  return (
    <Modal title={`Edit ${column.name}`} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Field
          label={column.type ?? "Value"}
          value={isNull ? "" : text}
          onChangeText={(next) => {
            setText(next);
            setIsNull(false);
          }}
          placeholder={isNull ? "NULL" : undefined}
          multiline={text.length > 60}
          mono
        />
        {column.nullable !== false ? (
          <View style={ui.wrap}>
            <Chip label="NULL" on={isNull} onPress={() => setIsNull((on) => !on)} />
          </View>
        ) : null}
        {error ? <Message kind="error" text={error} /> : null}
        <Text style={ui.muted}>This is added to the pending list. Nothing is written until you commit.</Text>
        <View style={[ui.row, { justifyContent: "flex-end" }]}>
          <Btn label="Cancel" onPress={onClose} />
          <Btn label="Add to pending" kind="primary" onPress={stage} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

function ColumnsModal({ names, hidden, visible, onClose, onChange }: { names: string[]; hidden: string[]; visible: number[]; onClose: () => void; onChange: (hidden: string[], order: string[]) => void }) {
  const ui = useUi();
  // Hidden columns stay in the list at the end, so they can be brought back.
  const shown = visible.map((position) => names[position] as string);
  const order = [...shown, ...names.filter((name) => !shown.includes(name))];
  const move = (name: string, by: number) => {
    const next = [...order];
    const from = next.indexOf(name);
    const to = from + by;
    if (to < 0 || to >= next.length) return;
    next.splice(from, 1);
    next.splice(to, 0, name);
    onChange(hidden, next);
  };
  return (
    <Modal title="Columns" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        {order.map((name) => {
          const isHidden = hidden.includes(name);
          return (
            <View key={name} style={[ui.row, { justifyContent: "space-between" }]}>
              <Text numberOfLines={1} style={[ui.mono, { flexShrink: 1, opacity: isHidden ? 0.5 : 1 }]}>
                {name}
              </Text>
              <View style={ui.row}>
                <Btn icon="ArrowUp" onPress={() => move(name, -1)} />
                <Btn icon="ArrowDown" onPress={() => move(name, 1)} />
                <Chip label={isHidden ? "Hidden" : "Shown"} on={!isHidden} disabled={!isHidden && shown.length === 1} onPress={() => onChange(isHidden ? hidden.filter((item) => item !== name) : [...hidden, name], order)} />
              </View>
            </View>
          );
        })}
        <View style={[ui.row, { justifyContent: "flex-end" }]}>
          <Btn label="Show all, original order" onPress={() => onChange([], [])} />
          <Btn label="Done" kind="primary" onPress={onClose} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

function FilterModal({ columns, ops, value, saved, onSaved, onClose, onApply }: { columns: string[]; ops: FilterOp[]; value: Filter[]; saved: SavedFilter[]; onSaved: (filters: SavedFilter[]) => void; onClose: () => void; onApply: (filters: Filter[]) => void }) {
  const ui = useUi();
  const [saveName, setSaveName] = useState("");
  const usable = (filters: Filter[]) => filters.every((filter) => columns.includes(filter.column));
  const [rows, setRows] = useState<Filter[]>(value.length > 0 ? value : [{ column: columns[0] ?? "", op: ops[0] ?? "eq", value: "" }]);
  const patch = (index: number, change: Partial<Filter>) => setRows((current) => current.map((row, position) => (position === index ? { ...row, ...change } : row)));
  return (
    <Modal title="Filter" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        {saved.length > 0 ? (
          <View style={{ gap: 4 }}>
            <Text style={ui.label}>Saved filters</Text>
            {saved.map((item) => (
              <View key={item.name} style={[ui.row, { justifyContent: "space-between" }]}>
                <Text numberOfLines={1} style={[ui.body, { flexShrink: 1 }]}>
                  {item.name}
                  {usable(item.filters) ? "" : " (uses a column this table no longer has)"}
                </Text>
                <View style={ui.row}>
                  <Btn label="Apply" disabled={!usable(item.filters)} onPress={() => onApply(item.filters)} />
                  <Btn icon="Trash2" onPress={() => onSaved(saved.filter((other) => other.name !== item.name))} />
                </View>
              </View>
            ))}
          </View>
        ) : null}
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
        <View style={[ui.row, { alignItems: "flex-end" }]}>
          <View style={{ flex: 1 }}>
            <Field label="Save this filter as" hint="Saved values are kept in a file only your user can read." value={saveName} onChangeText={setSaveName} />
          </View>
          <Btn
            label="Save"
            disabled={saveName.trim() === "" || rows.every((row) => row.column === "")}
            onPress={() => {
              onSaved([...saved.filter((item) => item.name !== saveName.trim()), { name: saveName.trim(), filters: rows.filter((row) => row.column !== "") }]);
              setSaveName("");
            }}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}
