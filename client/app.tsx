import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { type ConnectionView, type ObjectInfo } from "../shared/contracts";
import { ENGINES } from "../shared/engines";
import { ConnectionForm, ConnectionList, UnlockPrompt } from "./connections";
import { DataTab } from "./data-tab";
import { Btn, Chip, ConfirmProvider, errorText, Message, UiProvider, useApi, useUi } from "./kit";
import { QueryTab } from "./query-tab";
import { StructureTab } from "./structure-tab";
import { ObjectTree, type Place } from "./tree";

export function DatawiseApp({ theme, layout }: PluginSurfaceProps) {
  return (
    <UiProvider theme={theme} compact={layout.compact}>
      <ConfirmProvider>
        <Main />
      </ConfirmProvider>
    </UiProvider>
  );
}

type Tab = "data" | "structure" | "query";

function Main() {
  const ui = useUi();
  const api = useApi();
  const connections = useQuery({ queryKey: ["datawise", "connections"], queryFn: () => api.listConnections({}) });
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [place, setPlace] = useState<Place>({});
  const [object, setObject] = useState<ObjectInfo | null>(null);
  const [tab, setTab] = useState<Tab>("data");
  const [queryPrefill, setQueryPrefill] = useState<{ text: string; revision: number } | null>(null);
  const [editing, setEditing] = useState<ConnectionView | "new" | null>(null);

  const list = connections.data?.connections ?? [];
  const connection = list.find((item) => item.id === connectionId) ?? null;

  const choose = (next: ConnectionView) => {
    setConnectionId(next.id);
    setPlace({});
    setObject(null);
    setTab("data");
  };
  const openQuery = (text?: string) => {
    if (text !== undefined) setQueryPrefill({ text, revision: Date.now() });
    setTab("query");
  };

  const rail = connection ? (
    <ObjectTree
      connection={connection}
      place={place}
      onPlace={(next) => {
        setPlace(next);
        setObject(null);
      }}
      selected={object?.name ?? null}
      onSelect={(next) => {
        setObject(next);
        setTab((current) => (current === "query" ? "data" : current));
      }}
      onBack={() => setConnectionId(null)}
      onEdit={() => setEditing(connection)}
      onQuery={openQuery}
    />
  ) : (
    <ConnectionList connections={list} loading={connections.isLoading} error={connections.error ? errorText(connections.error) : null} onChoose={choose} onAdd={() => setEditing("new")} onEdit={setEditing} />
  );

  const showContent = connection !== null && !connection.needsPassword && (object !== null || tab === "query");
  const content = connection && showContent ? <Content connection={connection} place={place} object={object} tab={tab} setTab={setTab} prefill={queryPrefill} onBack={() => (tab === "query" && !object ? setTab("data") : setObject(null))} onDropped={() => setObject(null)} /> : null;

  return (
    <View style={ui.root}>
      {connection?.needsPassword ? <UnlockPrompt connection={connection} onDone={() => connections.refetch()} onCancel={() => setConnectionId(null)} /> : null}
      {ui.compact ? (
        showContent ? content : rail
      ) : (
        <View style={{ flex: 1, minHeight: 0, flexDirection: "row" }}>
          <View style={{ width: 280, borderRightWidth: 1, borderRightColor: ui.colors.border, minHeight: 0 }}>{rail}</View>
          <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>{content ?? <EmptyContent hasConnection={connection !== null} hasAny={list.length > 0} />}</View>
        </View>
      )}
      {editing ? (
        <ConnectionForm
          connection={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            void connections.refetch();
            choose(saved);
          }}
          onDeleted={(id) => {
            setEditing(null);
            if (id === connectionId) setConnectionId(null);
            void connections.refetch();
          }}
        />
      ) : null}
    </View>
  );
}

function EmptyContent({ hasConnection, hasAny }: { hasConnection: boolean; hasAny: boolean }) {
  const ui = useUi();
  const text = hasConnection ? "Choose an object on the left, or open the query box." : hasAny ? "Choose a connection." : "Add a connection to start.";
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
      <Text style={ui.muted}>{text}</Text>
    </View>
  );
}

function Content({ connection, place, object, tab, setTab, prefill, onBack, onDropped }: { connection: ConnectionView; place: Place; object: ObjectInfo | null; tab: Tab; setTab: (tab: Tab) => void; prefill: { text: string; revision: number } | null; onBack: () => void; onDropped: () => void }) {
  const ui = useUi();
  const info = ENGINES[connection.engine];
  const scope = { connectionId: connection.id, ...place };
  const ref = object ? { ...scope, name: object.name } : null;
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={[ui.toolbar, { justifyContent: "space-between" }]}>
        <View style={[ui.row, { flexShrink: 1 }]}>
          {ui.compact ? <Btn icon="ArrowLeft" onPress={onBack} /> : null}
          <Text numberOfLines={1} style={[ui.title, { flexShrink: 1 }]}>
            {tab === "query" ? "Query" : object?.name}
          </Text>
          {connection.safety === "read-only" ? <Chip label="Read-only" on={false} onPress={() => undefined} disabled /> : null}
        </View>
        <View style={ui.wrap}>
          {ref ? <Chip label="Data" on={tab === "data"} onPress={() => setTab("data")} /> : null}
          {ref ? <Chip label="Structure" on={tab === "structure"} onPress={() => setTab("structure")} /> : null}
          <Chip label={info.queryLanguage === "SQL" ? "SQL" : "Query"} on={tab === "query"} onPress={() => setTab("query")} />
        </View>
      </View>
      {connection.notEncrypted ? (
        <View style={{ paddingHorizontal: 12 }}>
          <Message kind="warning" text="Not encrypted: this connection sends data and its password in the clear." />
        </View>
      ) : null}
      {tab === "data" && ref ? <DataTab key={JSON.stringify(ref)} connection={connection} refObject={ref} /> : null}
      {tab === "structure" && ref ? <StructureTab key={JSON.stringify(ref)} connection={connection} refObject={ref} onDropped={onDropped} /> : null}
      {/* Kept mounted, so moving between tabs does not lose the text or the results. */}
      <View style={{ flex: tab === "query" ? 1 : 0, minHeight: 0, display: tab === "query" ? "flex" : "none" }}>
        <QueryTab connection={connection} scope={scope} prefill={prefill} />
      </View>
    </View>
  );
}
