import { copyText, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ColumnInfo, ConnectionView, Filter, ObjectDetails, ObjectRef, RowKey } from "../shared/contracts";
import { ENGINES } from "../shared/engines";
import { jumpFilters } from "../shared/foreign-keys";
import { parseEdited } from "../shared/values";
import { Btn, cellText, Chip, errorText, Field, isBytes, Message, Modal, useApi, useGuardedRun, useUi } from "./kit";

export type RowFormMode = { kind: "insert"; values?: Record<string, unknown> } | { kind: "edit"; key: RowKey; row: unknown[]; hasCutCells: boolean };

interface FieldState {
  text: string;
  isNull: boolean;
  touched: boolean;
}

export function RowForm({ connection, refObject, columns, keyColumns, keyReason, mode, foreignKeys = [], onJump, onClose, onChanged, onDuplicate }: { connection: ConnectionView; refObject: ObjectRef; columns: ColumnInfo[]; keyColumns: string[]; keyReason: string | null; mode: RowFormMode; foreignKeys?: ObjectDetails["foreignKeys"]; onJump?: (key: ObjectDetails["foreignKeys"][number], filters: Filter[]) => void; onClose: () => void; onChanged: () => void; onDuplicate: (values: Record<string, unknown>) => void }) {
  const ui = useUi();
  const api = useApi();
  const toast = useToast();
  const guarded = useGuardedRun();
  const info = ENGINES[connection.engine];
  const editing = mode.kind === "edit";
  const canWrite = connection.safety !== "read-only";

  // A cut value must not be saved back, so an edit always starts from the whole row.
  const full = useQuery({ queryKey: ["datawise", "row", refObject, editing ? mode.key : null], queryFn: () => api.readRow({ ref: refObject, key: (mode as { key: RowKey }).key }), enabled: editing && mode.hasCutCells, gcTime: 0, retry: false });
  const shownColumns = full.data?.columns ?? columns;
  const shownRow = editing ? (full.data?.rows[0] ?? (mode.hasCutCells ? null : mode.row)) : null;

  const [fields, setFields] = useState<Record<string, FieldState>>({});
  const [newField, setNewField] = useState("");
  const [extra, setExtra] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const original = (name: string): unknown => {
    if (!shownRow) return mode.kind === "insert" ? (mode.values?.[name] ?? null) : null;
    return shownRow[shownColumns.findIndex((column) => column.name === name)] ?? null;
  };

  useEffect(() => {
    if (editing && !shownRow) return;
    const next: Record<string, FieldState> = {};
    for (const column of shownColumns) {
      const value = original(column.name);
      next[column.name] = { text: value === null ? "" : cellText(value), isNull: value === null, touched: false };
    }
    setFields(next);
    // Only when a different row arrives; typing must not reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownRow, shownColumns]);

  const update = (name: string, patch: Partial<FieldState>) => setFields((current) => ({ ...current, [name]: { ...(current[name] ?? { text: "", isNull: false }), ...patch, touched: true } }));
  const allNames = [...shownColumns.map((column) => column.name), ...extra];
  const schemaless = !shownColumns.some((column) => column.type !== null);

  const collect = (): Record<string, unknown> => {
    const values: Record<string, unknown> = {};
    for (const name of allNames) {
      const state = fields[name];
      if (!state) continue;
      if (mode.kind === "edit") {
        // Only what changed, so an edit cannot rewrite a value the user never touched.
        if (!state.touched) continue;
        const before = original(name);
        const value = state.isNull ? null : parseEdited(state.text, before, info.schemaless);
        if (JSON.stringify(value) !== JSON.stringify(before)) values[name] = value;
      } else if (!state.touched && mode.values && mode.values[name] !== undefined && mode.values[name] !== null) {
        // A duplicated value the user did not touch goes exactly as it was, including bytes and "".
        values[name] = mode.values[name];
      } else if (state.isNull) {
        if (state.touched) values[name] = null;
      } else if (state.text !== "" || state.touched) {
        values[name] = parseEdited(state.text, null, info.schemaless);
      }
    }
    return values;
  };

  const write = async (op: Parameters<typeof api.writeRows>[0]["op"]) => {
    setBusy(true);
    setError(null);
    try {
      const job = await guarded(api, (confirmed) => api.writeRows({ ref: refObject, op, confirmed }));
      if (!job) return;
      if (job.status !== "done") throw new Error(job.error ?? `The write ended as ${job.status}.`);
      toast.show("Saved", { variant: "success" });
      onChanged();
      onClose();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    try {
      const values = collect();
      if (mode.kind === "edit") {
        if (Object.keys(values).length === 0) {
          onClose();
          return;
        }
        void write({ kind: "update", key: mode.key, changes: values });
      } else void write({ kind: "insert", values });
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  const title = editing ? `Row in ${refObject.name}` : `New row in ${refObject.name}`;
  const editable = editing ? info.canEditRows && keyColumns.length > 0 && canWrite : info.canInsertRows && canWrite;
  const asObject = () => Object.fromEntries(shownColumns.map((column) => [column.name, original(column.name)]));
  const jumps = editing && shownRow && onJump ? foreignKeys.flatMap((key) => {
    const filters = jumpFilters(key, original);
    return filters ? [{ key, filters }] : [];
  }) : [];

  return (
    <Modal title={title} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        {editing && keyColumns.length === 0 ? <Message kind="warning" text={keyReason ?? "This row cannot be changed from here."} /> : null}
        {!canWrite ? <Message kind="note" text="This connection is read-only." /> : null}
        {full.isLoading ? <Message kind="note" text="Loading the whole row…" /> : null}
        {full.error ? <Message kind="error" text={errorText(full.error)} /> : null}
        {allNames.map((name) => {
          const column = shownColumns.find((item) => item.name === name);
          const state = fields[name] ?? { text: "", isNull: !editing, touched: false };
          const raw = original(name);
          const locked = !editable || isBytes(raw) || (column?.generated === true && editing);
          return (
            <View key={name} style={{ gap: 3 }}>
              <Field
                label={`${name}${column?.type ? `  ·  ${column.type}` : ""}${column?.isKey ? "  ·  key" : ""}`}
                value={state.isNull ? "" : state.text}
                onChangeText={(text) => update(name, { text, isNull: false })}
                placeholder={state.isNull ? (column?.defaultValue ? `default: ${column.defaultValue}` : column?.generated ? "set by the database" : "NULL") : undefined}
                multiline={state.text.length > 60 || (raw !== null && typeof raw === "object")}
                mono
                editable={!locked}
              />
              {!locked && column?.nullable !== false ? (
                <View style={ui.wrap}>
                  <Chip label="NULL" on={state.isNull} onPress={() => update(name, { isNull: !state.isNull })} />
                </View>
              ) : null}
            </View>
          );
        })}
        {jumps.length > 0 ? (
          <View style={{ gap: 4 }}>
            <Text style={ui.label}>Go to the row this points at</Text>
            <View style={ui.wrap}>
              {jumps.map(({ key, filters }) => (
                <Btn key={key.name} icon="ArrowRight" label={`${key.columns.join(", ")} → ${key.targetTable}`} onPress={() => onJump?.(key, filters)} />
              ))}
            </View>
          </View>
        ) : null}
        {!editing || (schemaless && editable) ? (
          <View style={ui.row}>
            <View style={{ flex: 1 }}>
              <Field label="Add a field" value={newField} onChangeText={setNewField} />
            </View>
            <View style={{ alignSelf: "flex-end" }}>
              <Btn
                label="Add"
                disabled={newField.trim() === "" || allNames.includes(newField.trim())}
                onPress={() => {
                  setExtra((current) => [...current, newField.trim()]);
                  update(newField.trim(), { text: "", isNull: false });
                  setNewField("");
                }}
              />
            </View>
          </View>
        ) : null}
        {error ? <Message kind="error" text={error} /> : null}
        <View style={[ui.row, { justifyContent: "space-between", flexWrap: "wrap" }]}>
          <View style={ui.row}>
            {editing && editable ? <Btn label="Delete" kind="danger" disabled={busy} onPress={() => void write({ kind: "delete", keys: [(mode as { key: RowKey }).key] })} /> : null}
            {editing && canWrite && info.canInsertRows ? <Btn label="Duplicate" disabled={busy} onPress={() => onDuplicate(asObject())} /> : null}
            {editing ? (
              <Btn
                icon="Copy"
                label="Copy"
                onPress={() =>
                  void copyText(JSON.stringify(asObject(), null, 2)).then(
                    () => toast.show("Copied", { variant: "success" }),
                    () => toast.error("Could not copy."),
                  )
                }
              />
            ) : null}
          </View>
          <View style={ui.row}>
            <Btn label="Close" onPress={onClose} />
            {editable ? <Btn label={busy ? "Saving…" : "Save"} kind="primary" disabled={busy || (editing && !shownRow)} onPress={save} /> : null}
          </View>
        </View>
        {editing && editable ? <Text style={ui.muted}>Last write wins: a change someone else made to the same value since this page loaded is replaced.</Text> : null}
      </Modal.Content>
    </Modal>
  );
}
