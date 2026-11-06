import { FlatList, Modal, TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ConnectionView, JobView, QueryResult, Scope } from "../shared/contracts";
import { ENGINES } from "../shared/engines";
import { Grid } from "./grid";
import { Btn, Chip, errorText, Field, Message, MONO, Select, useApi, useGuardedRun, useUi } from "./kit";
import { ExportModal } from "./transfer";

const LIMITS = [100, 1000, 10000, 100000];
const TIMEOUTS = [
  { label: "30 s limit", value: 30000 },
  { label: "1 min limit", value: 60000 },
  { label: "5 min limit", value: 300000 },
  { label: "30 min limit", value: 1800000 },
];

function rowCount(count: number): string {
  return `${count} row${count === 1 ? "" : "s"}`;
}

export function QueryTab({ connection, scope, prefill }: { connection: ConnectionView; scope: Scope; prefill: { text: string; revision: number } | null }) {
  const ui = useUi();
  const api = useApi();
  const guarded = useGuardedRun();
  const info = ENGINES[connection.engine];
  const [text, setText] = useState(prefill?.text ?? "");
  const [limit, setLimit] = useState(1000);
  const [timeoutMs, setTimeoutMs] = useState(60000);
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [panel, setPanel] = useState<"history" | "saved" | "save" | null>(null);
  const [exporting, setExporting] = useState(false);
  const running = useRef(false);
  const results: QueryResult[] = job?.results ?? [];
  const current = results[Math.min(active, results.length - 1)];
  const isRunning = job?.status === "running";

  useEffect(() => {
    if (prefill) setText(prefill.text);
  }, [prefill]);

  const execute = async (statement: string, explain = false) => {
    if (running.current || statement.trim() === "") return;
    running.current = true;
    setError(null);
    setActive(0);
    setJob(null);
    try {
      const done = await guarded(api, (confirmed) => api.runQuery({ scope, text: statement, limit, timeoutMs, explain, confirmed }), setJob, setJob);
      if (done) setJob(done);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      running.current = false;
    }
  };

  const outcome = (() => {
    if (!job) return null;
    if (job.status === "running") return <Message kind="note" text="Running…" />;
    if (job.status === "cancelled") return <Message kind="warning" text="Stopped." />;
    if (job.status === "failed") return <Message kind="error" text={`${job.error ?? "Failed."}${results.length > 0 ? ` The ${results.length} statement${results.length === 1 ? "" : "s"} before it already ran and stay applied.` : ""}`} />;
    return null;
  })();

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={{ padding: 8, gap: 6, borderBottomWidth: 1, borderBottomColor: ui.colors.border }}>
        <TextInput accessibilityLabel={`${info.queryLanguage} to run`} value={text} onChangeText={setText} placeholder={info.queryPlaceholder} placeholderTextColor={ui.colors.foregroundMuted} multiline autoCapitalize="none" autoCorrect={false} spellCheck={false} style={[ui.input, { fontFamily: MONO, fontSize: 12, height: ui.compact ? 120 : 160, textAlignVertical: "top" }]} />
        <View style={ui.wrap}>
          {isRunning ? <Btn icon="Square" label="Stop" kind="danger" onPress={() => job && void api.cancelJob({ id: job.id })} /> : <Btn icon="Play" label="Run" kind="primary" disabled={text.trim() === ""} onPress={() => void execute(text)} />}
          {info.explainPrefix ? <Btn label="Explain" disabled={isRunning || text.trim() === ""} onPress={() => void execute(text, true)} /> : null}
          <Select label="Most rows to show" value={String(limit)} options={LIMITS.map((value) => ({ label: `${value} rows`, value: String(value) }))} onChange={(value) => setLimit(Number(value))} />
          <Select label="Time limit" value={String(timeoutMs)} options={TIMEOUTS.map((option) => ({ label: option.label, value: String(option.value) }))} onChange={(value) => setTimeoutMs(Number(value))} />
          <Btn icon="History" label="History" onPress={() => setPanel("history")} />
          <Btn icon="Bookmark" label="Saved" onPress={() => setPanel("saved")} />
          <Btn icon="BookmarkPlus" disabled={text.trim() === ""} onPress={() => setPanel("save")} />
          <Btn icon="Download" label="Export" disabled={text.trim() === ""} onPress={() => setExporting(true)} />
        </View>
        <Text style={ui.muted}>{info.queryLanguage}. Statements run one at a time, each in a fresh session for this run; if one fails, the rest do not run.</Text>
        {error ? <Message kind="error" text={error} /> : null}
        {outcome}
      </View>
      {results.length > 1 ? (
        <View style={[ui.toolbar]}>
          {results.map((_, index) => (
            <Chip key={index} label={`Result ${index + 1}`} on={index === active} onPress={() => setActive(index)} />
          ))}
        </View>
      ) : null}
      {current ? (
        <View style={{ flex: 1, minHeight: 0 }}>
          <View style={{ paddingHorizontal: 12, paddingVertical: 4 }}>
            <Text style={ui.muted}>
              {current.columns.length > 0 ? rowCount(current.rows.length) : current.affected !== null ? `${rowCount(current.affected)} changed` : "Done"}
              {current.truncated ? `, cut at the limit` : ""} · {current.durationMs} ms
              {current.message ? ` · ${current.message}` : ""}
            </Text>
          </View>
          {current.columns.length > 0 ? <Grid columns={current.columns} rows={current.rows} cutCells={current.cutCells} /> : null}
        </View>
      ) : null}
      {panel === "history" ? (
        <HistoryModal
          connectionId={connection.id}
          onClose={() => setPanel(null)}
          onPick={(value) => {
            setText(value);
            setPanel(null);
          }}
        />
      ) : null}
      {panel === "saved" ? (
        <SavedModal
          connectionId={connection.id}
          onClose={() => setPanel(null)}
          onPick={(value) => {
            setText(value);
            setPanel(null);
          }}
        />
      ) : null}
      {panel === "save" ? <SaveModal connectionId={connection.id} text={text} onClose={() => setPanel(null)} /> : null}
      {exporting ? <ExportModal connection={connection} source={{ kind: "query", scope, text }} name="query" onClose={() => setExporting(false)} /> : null}
    </View>
  );
}

function PickRow({ title, detail, onPress, trailing }: { title: string; detail?: string; onPress: () => void; trailing?: ReactNode }) {
  const ui = useUi();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: ui.colors.border }}>
      <Pressable accessibilityRole="button" onPress={onPress} style={{ flex: 1, minWidth: 0, padding: 12, gap: 2 }}>
        <Text numberOfLines={3} style={ui.mono}>
          {title}
        </Text>
        {detail ? <Text style={ui.muted}>{detail}</Text> : null}
      </Pressable>
      {trailing ? <View style={{ paddingRight: 8 }}>{trailing}</View> : null}
    </View>
  );
}

function HistoryModal({ connectionId, onClose, onPick }: { connectionId: string; onClose: () => void; onPick: (text: string) => void }) {
  const ui = useUi();
  const api = useApi();
  const history = useQuery({ queryKey: ["datawise", connectionId, "history"], queryFn: () => api.listHistory({ connectionId }), gcTime: 0 });
  return (
    <Modal title="History" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content scrollable={false} contentContainerStyle={{ padding: 0, gap: 0 }}>
        <View style={{ padding: 8, flexDirection: "row", justifyContent: "flex-end" }}>
          <Btn label="Clear history" onPress={() => void api.clearHistory({ connectionId }).then(() => history.refetch())} />
        </View>
        {history.data?.entries.length === 0 ? <View style={{ padding: 12 }}><Text style={ui.muted}>Nothing yet.</Text></View> : null}
        <FlatList style={{ flex: 1, minHeight: 0 }} data={history.data?.entries ?? []} keyExtractor={(entry) => entry.id} renderItem={({ item }) => <PickRow title={item.text} detail={`${new Date(item.ranAt).toLocaleString()}${item.durationMs !== null ? ` · ${item.durationMs} ms` : ""}${item.ok ? "" : " · failed"}`} onPress={() => onPick(item.text)} />} />
      </Modal.Content>
    </Modal>
  );
}

function SavedModal({ connectionId, onClose, onPick }: { connectionId: string; onClose: () => void; onPick: (text: string) => void }) {
  const ui = useUi();
  const api = useApi();
  const saved = useQuery({ queryKey: ["datawise", connectionId, "saved"], queryFn: () => api.listSaved({ connectionId }), gcTime: 0 });
  return (
    <Modal title="Saved queries" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content scrollable={false} contentContainerStyle={{ padding: 0, gap: 0 }}>
        {saved.data?.queries.length === 0 ? <View style={{ padding: 12 }}><Text style={ui.muted}>Nothing saved yet.</Text></View> : null}
        <FlatList style={{ flex: 1, minHeight: 0 }} data={saved.data?.queries ?? []} keyExtractor={(query) => query.id} renderItem={({ item }) => <PickRow title={item.name} detail={item.text.slice(0, 120)} onPress={() => onPick(item.text)} trailing={<Btn icon="Trash2" onPress={() => void api.deleteSaved({ connectionId, id: item.id }).then(() => saved.refetch())} />} />} />
      </Modal.Content>
    </Modal>
  );
}

function SaveModal({ connectionId, text, onClose }: { connectionId: string; text: string; onClose: () => void }) {
  const ui = useUi();
  const api = useApi();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Save query" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Field label="Name" value={name} onChangeText={setName} />
        {error ? <Message kind="error" text={error} /> : null}
        <View style={[ui.row, { justifyContent: "flex-end" }]}>
          <Btn label="Cancel" onPress={onClose} />
          <Btn label="Save" kind="primary" disabled={name.trim() === ""} onPress={() => void api.saveQuery({ connectionId, name, text }).then(onClose, (failure: unknown) => setError(errorText(failure)))} />
        </View>
      </Modal.Content>
    </Modal>
  );
}
