import { Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { Text, View } from "react-native";
import type { ConnectionView, ObjectRef } from "../shared/contracts";
import { ENGINES } from "../shared/engines";
import { Btn, errorText, Field, Message, Modal, useApi, useGuardedRun, useUi } from "./kit";

export function StructureTab({ connection, refObject, onDropped }: { connection: ConnectionView; refObject: ObjectRef; onDropped: () => void }) {
  const ui = useUi();
  const api = useApi();
  const info = ENGINES[connection.engine];
  const details = useQuery({ queryKey: ["datawise", "describe", refObject], queryFn: () => api.describeObject(refObject), retry: false });
  const [destroying, setDestroying] = useState<"drop" | "truncate" | null>(null);
  const data = details.data;
  const canDestroy = connection.safety !== "read-only";
  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: ui.compact ? 12 : 16, gap: 14 }}>
      {details.isLoading ? <Message kind="note" text="Loading…" /> : null}
      {details.error ? <Message kind="error" text={errorText(details.error)} /> : null}
      {data ? (
        <>
          {data.facts.length > 0 ? (
            <View style={ui.wrap}>
              {data.facts.map((fact) => (
                <Text key={fact.label} selectable style={[ui.body, { paddingRight: 12 }]}>
                  <Text style={ui.muted}>{fact.label} </Text>
                  {fact.value}
                </Text>
              ))}
            </View>
          ) : null}
          {data.keyReason ? <Message kind="note" text={data.keyReason} /> : null}
          <Section title="Columns">
            {data.columns.map((column) => (
              <View key={column.name} style={{ flexDirection: ui.compact ? "column" : "row", gap: ui.compact ? 2 : 12, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: ui.colors.border }}>
                <View style={[ui.row, { flex: 2, gap: 4 }]}>
                  {column.isKey ? <Icon name="KeyRound" size={12} color={ui.colors.statusWarning} /> : null}
                  <Text selectable style={ui.mono}>
                    {column.name}
                  </Text>
                </View>
                <Text selectable style={[ui.muted, { flex: 2 }]}>
                  {column.type ?? "any"}
                  {column.nullable === false ? " · not null" : ""}
                  {column.generated ? " · generated" : ""}
                </Text>
                <Text selectable numberOfLines={1} style={[ui.muted, { flex: 2 }]}>
                  {column.defaultValue ? `default ${column.defaultValue}` : ""}
                </Text>
              </View>
            ))}
          </Section>
          {data.indexes.length > 0 ? (
            <Section title="Indexes">
              {data.indexes.map((index) => (
                <Text key={index.name} selectable style={ui.mono}>
                  {index.name} ({index.columns.join(", ")}){index.unique ? " unique" : ""}
                </Text>
              ))}
            </Section>
          ) : null}
          {data.foreignKeys.length > 0 ? (
            <Section title="Foreign keys">
              {data.foreignKeys.map((key) => (
                <Text key={key.name} selectable style={ui.mono}>
                  {key.name}: {key.columns.join(", ")} → {key.references}
                </Text>
              ))}
            </Section>
          ) : null}
          {data.definition ? (
            <Section title="Definition">
              <View style={ui.card}>
                <Text selectable style={ui.mono}>
                  {data.definition}
                </Text>
              </View>
            </Section>
          ) : null}
          {canDestroy && (info.canDrop || info.canTruncate) ? (
            <Section title="Danger">
              <View style={ui.wrap}>
                {info.canTruncate ? <Btn label="Empty it" kind="danger" onPress={() => setDestroying("truncate")} /> : null}
                {info.canDrop ? <Btn label={`Delete this ${info.objectLabel}`} kind="danger" onPress={() => setDestroying("drop")} /> : null}
              </View>
            </Section>
          ) : null}
        </>
      ) : null}
      {destroying ? <DestroyModal refObject={refObject} action={destroying} onClose={() => setDestroying(null)} onDone={() => (destroying === "drop" ? onDropped() : setDestroying(null))} /> : null}
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const ui = useUi();
  return (
    <View style={{ gap: 6 }}>
      <Text style={ui.label}>{title}</Text>
      {children}
    </View>
  );
}

function DestroyModal({ refObject, action, onClose, onDone }: { refObject: ObjectRef; action: "drop" | "truncate"; onClose: () => void; onDone: () => void }) {
  const ui = useUi();
  const api = useApi();
  const guarded = useGuardedRun();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const job = await guarded(api, () => api.destroyObject({ ref: refObject, action, confirmName: name }));
      if (job && job.status !== "done") throw new Error(job.error ?? `This ended as ${job.status}.`);
      onDone();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={action === "drop" ? "Delete permanently" : "Remove all rows"} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Text style={ui.body}>This cannot be undone. Type {refObject.name} to confirm.</Text>
        <Field label="Name" value={name} onChangeText={setName} mono />
        {error ? <Message kind="error" text={error} /> : null}
        <View style={[ui.row, { justifyContent: "flex-end" }]}>
          <Btn label="Cancel" onPress={onClose} />
          <Btn label={busy ? "Working…" : "Confirm"} kind="danger" disabled={busy || name !== refObject.name} onPress={() => void run()} />
        </View>
      </Modal.Content>
    </Modal>
  );
}
