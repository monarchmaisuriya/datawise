import { copyText, FlatList, useToast } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ConnectionView, JobView, QueryResult, QueryTabRecord, QueryTabs, Scope } from "../shared/contracts";
import { ENGINES } from "../shared/engines";
import { toMarkdownTable } from "../shared/markdown";
import { QUERY_LIMITS, TIME_LIMITS_MS } from "../shared/preferences";
import { Grid } from "./grid";
import { Btn, Chip, errorText, Field, Message, Modal, Select, useApi, useConfirm, useGuardedRun, useUi } from "./kit";
import { usePreferences } from "./preferences";
import { type EditorControl, SqlEditor } from "./sql-editor";
import { ExportModal } from "./transfer";

const TIME_LABELS: Record<number, string> = { 30000: "30 s limit", 60000: "1 min limit", 300000: "5 min limit", 1800000: "30 min limit" };
const MAX_TABS = 30;

function rowCount(count: number): string {
  return `${count} row${count === 1 ? "" : "s"}`;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// A pasted Windows line ending would make what the person selected differ from what is sent.
function normalized(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function freshTabs(): QueryTabs {
  const id = newId();
  return { activeId: id, tabs: [{ id, name: "Query 1", text: "" }] };
}

// Several named tabs per connection. Text is saved after a second of quiet, so a reload keeps the drafts.
export function QueryWorkspace({ connection, scope, prefill, onPrefillUsed }: { connection: ConnectionView; scope: Scope; prefill: { text: string; revision: number } | null; onPrefillUsed: () => void }) {
  const ui = useUi();
  const api = useApi();
  const ask = useConfirm();
  const [state, setState] = useState<QueryTabs | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const lastSaved = useRef<string>("");
  const stateNow = useRef(state);
  stateNow.current = state;

  useEffect(() => {
    let live = true;
    setLoadError(null);
    // A failed read is not an empty one. Starting fresh here would replace the saved drafts on the next key.
    api.getQueryTabs({ connectionId: connection.id }).then(
      (answer) => {
        if (!live) return;
        const value = answer.tabs ?? freshTabs();
        lastSaved.current = JSON.stringify(value);
        setState(value);
      },
      (failure: unknown) => {
        if (live) setLoadError(errorText(failure));
      },
    );
    return () => {
      live = false;
    };
    // The api object is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, attempt]);

  // Leaving within the quiet second must not lose what was just typed.
  useEffect(
    () => () => {
      const latest = stateNow.current;
      if (latest && JSON.stringify(latest) !== lastSaved.current) void api.saveQueryTabs({ connectionId: connection.id, tabs: latest }).catch(() => undefined);
    },
    // The api object is stable, and this view is rebuilt for each connection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (!state || JSON.stringify(state) === lastSaved.current) return;
    const timer = setTimeout(() => {
      lastSaved.current = JSON.stringify(state);
      api.saveQueryTabs({ connectionId: connection.id, tabs: state }).then(
        () => setSaveError(null),
        (failure: unknown) => setSaveError(errorText(failure)),
      );
    }, 1000);
    return () => clearTimeout(timer);
    // The api object is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, connection.id]);

  useEffect(() => {
    if (!state || !prefill) return;
    onPrefillUsed();
    const active = state.tabs.find((tab) => tab.id === state.activeId);
    const text = normalized(prefill.text);
    if (active && active.text.trim() === "") {
      setState({ ...state, tabs: state.tabs.map((tab) => (tab.id === active.id ? { ...tab, text } : tab)) });
    } else if (state.tabs.length >= MAX_TABS) {
      setNotice(`This connection already has ${MAX_TABS} tabs. Close one and try again.`);
    } else {
      const id = newId();
      setState({ activeId: id, tabs: [...state.tabs, { id, name: `Query ${state.tabs.length + 1}`, text }] });
    }
    // Only a new prefill or the first load. The handler is fresh on each render and changes nothing here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, state]);

  if (loadError) {
    return (
      <View style={{ padding: 12, gap: 8 }}>
        <Message kind="error" text={`This connection's query tabs could not be read: ${loadError}`} />
        <View style={{ alignSelf: "flex-start" }}>
          <Btn label="Try again" onPress={() => setAttempt((count) => count + 1)} />
        </View>
      </View>
    );
  }
  if (!state) return <View style={{ flex: 1 }} />;
  const patch = (id: string, change: Partial<QueryTabRecord>) => setState((current) => current && { ...current, tabs: current.tabs.map((tab) => (tab.id === id ? { ...tab, ...change } : tab)) });
  const close = async (id: string) => {
    const closing = state.tabs.find((tab) => tab.id === id);
    // Its text exists nowhere else, so this cannot be undone.
    if (closing && closing.text.trim() !== "") {
      const sure = await ask({ title: `Close ${closing.name}?`, preview: closing.text.slice(0, 500), reason: "This query is not saved anywhere else.", actionLabel: "Close tab" });
      if (!sure) return;
    }
    setState((current) => {
      if (!current) return current;
      const tabs = current.tabs.filter((tab) => tab.id !== id);
      if (tabs.length === 0) return freshTabs();
      return { activeId: current.activeId === id ? (tabs[tabs.length - 1] as QueryTabRecord).id : current.activeId, tabs };
    });
  };
  const add = () => {
    const id = newId();
    setState((current) => current && { activeId: id, tabs: [...current.tabs, { id, name: `Query ${current.tabs.length + 1}`, text: "" }] });
  };

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={[ui.toolbar, { paddingVertical: 4 }]}>
        {state.tabs.map((tab) => (
          <Chip key={tab.id} label={tab.name} on={tab.id === state.activeId} onPress={() => (tab.id === state.activeId ? setRenaming(tab.id) : setState({ ...state, activeId: tab.id }))} />
        ))}
        <Btn icon="Plus" disabled={state.tabs.length >= MAX_TABS} onPress={add} />
        {state.tabs.length > 1 || state.tabs[0]?.text ? <Btn icon="X" label="Close tab" onPress={() => void close(state.activeId)} /> : null}
      </View>
      {saveError ? <View style={{ paddingHorizontal: 12 }}><Message kind="warning" text={`Drafts could not be saved: ${saveError}`} /></View> : null}
      {notice ? <View style={{ paddingHorizontal: 12 }}><Message kind="warning" text={notice} /></View> : null}
      {/* All kept mounted, so moving between tabs loses neither results nor undo history. */}
      {state.tabs.map((tab) => (
        <View key={tab.id} style={{ flex: tab.id === state.activeId ? 1 : 0, minHeight: 0, display: tab.id === state.activeId ? "flex" : "none" }}>
          <QueryPane connection={connection} scope={scope} text={tab.text} onText={(text) => patch(tab.id, { text })} active={tab.id === state.activeId} />
        </View>
      ))}
      {renaming ? <RenameModal name={state.tabs.find((tab) => tab.id === renaming)?.name ?? ""} onClose={() => setRenaming(null)} onSave={(name) => {
        patch(renaming, { name });
        setRenaming(null);
      }} /> : null}
    </View>
  );
}

function RenameModal({ name, onClose, onSave }: { name: string; onClose: () => void; onSave: (name: string) => void }) {
  const ui = useUi();
  const [value, setValue] = useState(name);
  return (
    <Modal title="Rename tab" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Field label="Name" value={value} onChangeText={(next) => setValue(next.slice(0, 60))} />
        <View style={[ui.row, { justifyContent: "flex-end" }]}>
          <Btn label="Cancel" onPress={onClose} />
          <Btn label="Save" kind="primary" disabled={value.trim() === ""} onPress={() => onSave(value.trim())} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

// One editor and its results. locked shows text it does not own, as for a file open in a panel.
export function QueryPane({ connection, scope, text, onText, active = true, locked = false }: { connection: ConnectionView; scope: Scope; text: string; onText: (text: string) => void; active?: boolean; locked?: boolean }) {
  const ui = useUi();
  const api = useApi();
  const guarded = useGuardedRun();
  const toast = useToast();
  const preferences = usePreferences();
  const info = ENGINES[connection.engine];
  const [limit, setLimit] = useState<number>(preferences.queryRowLimit);
  const [timeoutMs, setTimeoutMs] = useState<number>(preferences.queryTimeLimitMs);
  const [selected, setSelected] = useState("");
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeResult, setActiveResult] = useState(0);
  const [panel, setPanel] = useState<"history" | "saved" | "save" | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const editor = useRef<EditorControl | null>(null);
  const running = useRef(false);
  const results: QueryResult[] = job?.results ?? [];
  const current = results[Math.min(activeResult, results.length - 1)];
  const isRunning = job?.status === "running";
  // Exactly the selected text or the whole text, read from the editor when pressed. The server parses
  // what it is sent, once. This state only labels the button.
  const hasSelection = selected.trim() !== "";
  const toRun = () => editor.current?.toRun() ?? text;

  // Replacing the text must also forget the selection, so a stale one cannot run a part of something else.
  const replaceText = (next: string) => {
    editor.current?.clearSelection();
    onText(normalized(next));
  };

  const execute = async (statement: string, explain = false) => {
    if (running.current || statement.trim() === "") return;
    running.current = true;
    setError(null);
    setActiveResult(0);
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

  const firstLine = selected.trim().split("\n")[0] ?? "";

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={{ padding: 8, gap: 6, borderBottomWidth: 1, borderBottomColor: ui.colors.border }}>
        <SqlEditor control={editor} connection={connection} scope={scope} text={text} onChangeText={(next) => onText(normalized(next))} onSelection={setSelected} onRun={() => void execute(toRun())} readOnly={locked} active={active} />
        <View style={ui.wrap}>
          {isRunning ? <Btn icon="Square" label="Stop" kind="danger" onPress={() => job && void api.cancelJob({ id: job.id })} /> : <Btn icon="Play" label={hasSelection ? "Run selection" : "Run"} kind="primary" disabled={text.trim() === ""} onPress={() => void execute(toRun())} />}
          {info.explainPrefix ? <Btn label="Explain" disabled={isRunning || text.trim() === ""} onPress={() => void execute(toRun(), true)} /> : null}
          <Select label="Most rows to show" value={String(limit)} options={QUERY_LIMITS.map((value) => ({ label: `${value} rows`, value: String(value) }))} onChange={(value) => setLimit(Number(value))} />
          <Select label="Time limit" value={String(timeoutMs)} options={TIME_LIMITS_MS.map((value) => ({ label: TIME_LABELS[value] as string, value: String(value) }))} onChange={(value) => setTimeoutMs(Number(value))} />
          {locked ? null : <Btn icon="History" label="History" onPress={() => setPanel("history")} />}
          {locked ? null : <Btn icon="Bookmark" label="Saved" onPress={() => setPanel("saved")} />}
          {locked ? null : <Btn icon="BookmarkPlus" disabled={text.trim() === ""} onPress={() => setPanel("save")} />}
          <Btn icon="Download" label="Export" disabled={text.trim() === ""} onPress={() => setExporting(toRun())} />
        </View>
        {hasSelection ? (
          <Text numberOfLines={1} style={ui.muted}>
            Selection, {selected.length} characters: {firstLine}
          </Text>
        ) : (
          <Text style={ui.muted}>{info.queryLanguage}. Statements run one at a time, each in a fresh session for this run; if one fails, the rest do not run.{locked ? "" : " Drafts: if two windows edit one tab, the last save wins."}</Text>
        )}
        {error ? <Message kind="error" text={error} /> : null}
        {outcome}
      </View>
      {results.length > 1 ? (
        <View style={[ui.toolbar]}>
          {results.map((_, index) => (
            <Chip key={index} label={`Result ${index + 1}`} on={index === activeResult} onPress={() => setActiveResult(index)} />
          ))}
        </View>
      ) : null}
      {current ? (
        <View style={{ flex: 1, minHeight: 0 }}>
          <View style={[ui.row, { paddingHorizontal: 12, paddingVertical: 4, justifyContent: "space-between" }]}>
            <Text style={[ui.muted, { flexShrink: 1 }]}>
              {current.columns.length > 0 ? rowCount(current.rows.length) : current.affected !== null ? `${rowCount(current.affected)} changed` : "Done"}
              {current.truncated ? `, cut at the limit` : ""} · {current.durationMs} ms
              {current.message ? ` · ${current.message}` : ""}
            </Text>
            {current.columns.length > 0 && current.rows.length > 0 ? (
              <Btn
                icon="ClipboardCopy"
                label="Copy as Markdown"
                onPress={() =>
                  void copyText(toMarkdownTable(current.columns.map((column) => column.name), current.rows, undefined, current.cutCells)).then(
                    () => toast.show(`Copied ${rowCount(current.rows.length)}`, { variant: "success" }),
                    () => toast.error("Could not copy."),
                  )
                }
              />
            ) : null}
          </View>
          {current.columns.length > 0 ? <Grid columns={current.columns} rows={current.rows} cutCells={current.cutCells} /> : null}
        </View>
      ) : null}
      {panel === "history" ? (
        <HistoryModal
          connectionId={connection.id}
          onClose={() => setPanel(null)}
          onPick={(value) => {
            replaceText(value);
            setPanel(null);
          }}
        />
      ) : null}
      {panel === "saved" ? (
        <SavedModal
          connectionId={connection.id}
          onClose={() => setPanel(null)}
          onPick={(value) => {
            replaceText(value);
            setPanel(null);
          }}
        />
      ) : null}
      {panel === "save" ? <SaveModal connectionId={connection.id} text={text} onClose={() => setPanel(null)} /> : null}
      {exporting !== null ? <ExportModal connection={connection} source={{ kind: "query", scope, text: exporting }} name="query" onClose={() => setExporting(null)} /> : null}
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
