import { type PluginFilePanelProps, useFileText } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { DatawiseProviders } from "./app";
import { ConnectionForm } from "./connections";
import { Btn, errorText, Message, Select, useApi, useUi } from "./kit";
import { QueryPane } from "./query-tab";

const NO_EDIT = () => undefined;

// The file stays Paseo's to edit, so this panel has no write path. Running goes through the normal query
// path, so the same safety rules apply as anywhere else.
export function SqlFilePanel({ file, theme, layout }: PluginFilePanelProps) {
  return (
    <DatawiseProviders theme={theme} compact={layout.compact}>
      <SqlFile file={file} />
    </DatawiseProviders>
  );
}

function SqlFile({ file }: { file: PluginFilePanelProps["file"] }) {
  const ui = useUi();
  const api = useApi();
  const text = useFileText(file);
  const connections = useQuery({ queryKey: ["datawise", "connections"], queryFn: () => api.listConnections({}) });
  const list = connections.data?.connections ?? [];
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const connection = list.find((item) => item.id === connectionId) ?? null;
  return (
    <View style={ui.root}>
      <View style={ui.toolbar}>
        <Text numberOfLines={1} style={[ui.title, { flexShrink: 1 }]}>
          {file.name}
        </Text>
        <Select label="Run on" value={connectionId ?? ""} placeholder="Choose a connection" options={list.map((item) => ({ label: item.name, value: item.id }))} onChange={setConnectionId} />
      </View>
      {text.status === "error" ? <View style={{ padding: 12 }}><Message kind="error" text={errorText(text.error)} /></View> : null}
      {connections.error ? <View style={{ padding: 12 }}><Message kind="error" text={errorText(connections.error)} /></View> : null}
      {text.status === "ready" && connection ? <QueryPane key={connection.id} connection={connection} scope={{ connectionId: connection.id, database: connection.database || undefined }} text={text.text.replace(/\r\n?/g, "\n")} onText={NO_EDIT} locked /> : null}
      {text.status === "ready" && !connection ? (
        <View style={{ padding: 12, gap: 8 }}>
          <Text style={ui.muted}>Choose a connection to run this file. Edit it in Paseo's own editor; this panel follows the file.</Text>
          <View style={ui.card}>
            <Text selectable numberOfLines={30} style={ui.mono}>
              {text.text}
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

export function SqliteFilePanel({ file, theme, layout }: PluginFilePanelProps) {
  return (
    <DatawiseProviders theme={theme} compact={layout.compact}>
      <SqliteFile file={file} />
    </DatawiseProviders>
  );
}

// Reads only the file's first bytes. Tables are not listed here, because opening a database can create
// files beside it, and nothing should do that before the person asks.
function SqliteFile({ file }: { file: PluginFilePanelProps["file"] }) {
  const ui = useUi();
  const api = useApi();
  const header = useQuery({ queryKey: ["datawise", "sqlite-header", file.path], queryFn: () => api.inspectSqlite({ path: file.path }), retry: false, gcTime: 0 });
  const [adding, setAdding] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const walNote = "This database uses write-ahead logging. Opening it, even read-only, creates -wal and -shm files beside it.";
  return (
    <View style={[ui.root, { padding: 16, gap: 10 }]}>
      <Text style={ui.title}>{file.name}</Text>
      {header.isLoading ? <Message kind="note" text="Reading the file header…" /> : null}
      {header.error ? <Message kind="error" text={errorText(header.error)} /> : null}
      {header.data && !header.data.isSqlite ? <Message kind="note" text="This file is not a SQLite database, so Datawise has nothing to open." /> : null}
      {header.data?.isSqlite ? (
        <>
          <Text style={ui.body}>A SQLite database. Add it as a connection to browse it in Datawise. It starts read-only, and you can change that.</Text>
          {header.data.wal ? <Message kind="warning" text={walNote} /> : null}
          {saved ? <Message kind="success" text={`Added as ${saved}. Open Datawise to browse it.`} /> : <View style={{ alignSelf: "flex-start" }}><Btn icon="Plus" label="Add as connection" kind="primary" onPress={() => setAdding(true)} /></View>}
        </>
      ) : null}
      {adding ? (
        <ConnectionForm
          connection={null}
          prefill={{ name: file.name, engine: "sqlite", file: file.path, safety: "read-only" }}
          note={header.data?.wal ? walNote : undefined}
          onClose={() => setAdding(false)}
          onSaved={(connection) => {
            setAdding(false);
            setSaved(connection.name);
          }}
          onDeleted={() => setAdding(false)}
        />
      ) : null}
    </View>
  );
}
