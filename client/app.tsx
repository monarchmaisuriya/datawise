import type { PluginSurfaceProps, PluginTab } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { type AgentOpenEvent, type ConnectionProposal, type ConnectionView, type Filter, type ObjectInfo } from "../shared/contracts";
import { onAgentOpen, productionQuestion, takeAgentOpen } from "./agent-open";
import { ENGINES } from "../shared/engines";
import { AgentRequestsModal, usePendingAgentRequests } from "./agent-requests";
import { ConnectionForm, ConnectionList, UnlockPrompt } from "./connections";
import { proposalNote } from "./proposal-note";
import { DataTab, type JumpTarget } from "./data-tab";
import { Btn, ConfirmProvider, connectionColorValue, errorText, Pill, Segmented, type Theme, UiProvider, useApi, useConfirm, useUi } from "./kit";
import { PendingProvider, usePending } from "./pending";
import { PreferencesProvider, usePreferences } from "./preferences";
import { QueryWorkspace } from "./query-tab";
import { StructureTab } from "./structure-tab";
import { ObjectTree, type Place } from "./tree";

type Tab = "data" | "structure" | "query";

// Everything a Datawise surface needs around it. Also used by the file panels.
export function DatawiseProviders({ theme, compact, children }: { theme: Theme; compact: boolean; children: ReactNode }) {
  return (
    <UiProvider theme={theme} compact={compact}>
      <ConfirmProvider>
        <PreferencesProvider>
          <ReadPolicy>{children}</ReadPolicy>
        </PreferencesProvider>
      </ConfirmProvider>
    </UiProvider>
  );
}

// The host gives each plugin a data cache with default options, where returning to the window reads
// everything again. Datawise decides that itself: data is read when opened, refreshed, or changed here.
function ReadPolicy({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const { rereadOnReturn } = usePreferences();
  const defaults = client.getDefaultOptions();
  // Set during render, before any query below reads its options. Setting the same value again does nothing.
  if (defaults.queries?.refetchOnWindowFocus !== rereadOnReturn) client.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, refetchOnWindowFocus: rereadOnReturn } });
  return children;
}

export function DatawiseApp(props: PluginSurfaceProps & { workspaceId?: string; tab?: PluginTab }) {
  const { theme, layout, workspaceId, tab } = props;
  return (
    <DatawiseProviders theme={theme} compact={layout.compact}>
      <PendingProvider onCount={tab ? (count) => tab.setModified(count > 0) : undefined}>
        <Main surface={workspaceId ? `panel:${workspaceId}` : "screen"} workspaceId={workspaceId} />
      </PendingProvider>
    </DatawiseProviders>
  );
}

function Main({ surface, workspaceId }: { surface: string; workspaceId?: string }) {
  const ui = useUi();
  const api = useApi();
  const ask = useConfirm();
  const pending = usePending();
  const connections = useQuery({ queryKey: ["datawise", "connections"], queryFn: () => api.listConnections({}) });
  const lastPlace = useQuery({ queryKey: ["datawise", "place", surface], queryFn: () => api.getPlace({ surface }), retry: false, gcTime: 0 });
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [place, setPlace] = useState<Place>({});
  const [object, setObject] = useState<ObjectInfo | null>(null);
  const [tab, setTab] = useState<Tab>("data");
  const [queryPrefill, setQueryPrefill] = useState<{ text: string; revision: number } | null>(null);
  const [editing, setEditing] = useState<ConnectionView | "new" | null>(null);
  const [jump, setJump] = useState<{ object: string; filters: Filter[]; revision: number } | null>(null);
  const [restored, setRestored] = useState(false);
  // Waits here until the connection can be used, as a session-only password may have to be asked for first.
  const [objectToRestore, setObjectToRestore] = useState<ObjectInfo | null>(null);
  const [agentRequestsOpen, setAgentRequestsOpen] = useState(false);
  const [reviewing, setReviewing] = useState<{ requestId: string; connectionId: string | null; values: ConnectionProposal } | null>(null);
  const waitingRequests = usePendingAgentRequests();

  const list = connections.data?.connections ?? [];
  const connection = list.find((item) => item.id === connectionId) ?? null;

  // Returns to where this surface was left, if it still exists. Anything gone means starting further up,
  // with no error, because a table dropped since last time is not a failure of this visit.
  useEffect(() => {
    if (restored || !connections.data || lastPlace.isLoading) return;
    setRestored(true);
    const saved = lastPlace.data?.place;
    const target = saved ? connections.data.connections.find((item) => item.id === saved.connectionId) : undefined;
    if (!saved || !target) return;
    setConnectionId(target.id);
    setPlace({ database: saved.database, schema: saved.schema });
    setTab(saved.tab);
    setObjectToRestore(saved.object);
  }, [restored, connections.data, lastPlace.isLoading, lastPlace.data]);

  useEffect(() => {
    if (!objectToRestore || !connection || connection.needsPassword) return;
    let live = true;
    api.describeObject({ connectionId: connection.id, database: place.database, schema: place.schema, name: objectToRestore.name }).then(
      () => {
        if (!live) return;
        setObject(objectToRestore);
        setObjectToRestore(null);
      },
      () => {
        if (!live) return;
        setObjectToRestore(null);
        setTab("data");
      },
    );
    return () => {
      live = false;
    };
    // The place was set with this object. The api object is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectToRestore, connection?.id, connection?.needsPassword]);

  useEffect(() => {
    // A place that could not be read must not be replaced with one built from nothing.
    if (!restored || !lastPlace.isSuccess) return;
    const timer = setTimeout(() => {
      const next = connectionId ? { connectionId, database: place.database, schema: place.schema, object: object ?? objectToRestore, tab } : null;
      // A place that cannot be saved costs only the return trip, so it does not interrupt the person.
      api.savePlace({ surface, place: next }).catch(() => undefined);
    }, 500);
    return () => clearTimeout(timer);
    // The api object is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored, lastPlace.isSuccess, surface, connectionId, place.database, place.schema, object, objectToRestore, tab]);

  // Pending edits are for one connection's tables. Leaving must not lose them without asking.
  const leaveAllowed = async (): Promise<boolean> => {
    if (pending.total === 0) return true;
    const sure = await ask({ title: "Discard pending edits?", preview: `${pending.total} row${pending.total === 1 ? "" : "s"} not committed`, reason: "Leaving this connection discards them.", actionLabel: "Discard" });
    if (sure) pending.clearAll();
    return sure;
  };

  // An agent asked to show a place in this workspace's tab. A production connection waits for the person's yes,
  // and leaving a connection with pending edits asks first, as leaving it by hand does.
  const showAgentRequest = async (event: AgentOpenEvent) => {
    if (event.production) {
      const sure = await ask({ title: "Open a production connection?", preview: productionQuestion(event), reason: "An agent asked for this. Nothing opens unless you say yes.", actionLabel: "Open" });
      if (!sure) return;
    }
    if (event.place.connectionId !== connectionId && !(await leaveAllowed())) return;
    // The connection may be newer than the list this tab read.
    await connections.refetch();
    setConnectionId(event.place.connectionId);
    setPlace({ database: event.place.database, schema: event.place.schema });
    setObject(null);
    setObjectToRestore(event.place.object);
    setJump(null);
    setTab(event.text !== null ? "query" : event.place.tab);
    if (event.text !== null) setQueryPrefill({ text: event.text, revision: Date.now() });
  };
  const showLatest = useRef(showAgentRequest);
  showLatest.current = showAgentRequest;
  // After the saved place is restored, so a request that opened this tab wins over where it was left.
  useEffect(() => {
    if (!restored || !workspaceId) return;
    const take = () => {
      const event = takeAgentOpen(workspaceId);
      if (event) void showLatest.current(event);
    };
    take();
    return onAgentOpen(take);
  }, [restored, workspaceId]);

  const choose = (next: ConnectionView) => {
    setConnectionId(next.id);
    setPlace({});
    setObject(null);
    setObjectToRestore(null);
    setQueryPrefill(null);
    setJump(null);
    setTab("data");
  };
  const openQuery = (text?: string) => {
    if (text !== undefined) setQueryPrefill({ text, revision: Date.now() });
    setTab("query");
  };
  const followForeignKey = ({ key, filters }: JumpTarget) => {
    if (!key.targetTable) return;
    setPlace((current) => ({ database: key.targetDatabase ?? current.database, schema: key.targetSchema ?? current.schema }));
    setObject({ name: key.targetTable, kind: "table" });
    setJump({ object: key.targetTable, filters, revision: Date.now() });
    setTab("data");
  };

  const rail = connection ? (
    <ObjectTree
      connection={connection}
      place={place}
      onPlace={(next) => {
        setPlace(next);
        // The tree reports the level it settled on, which is not a move when nothing changed.
        if (next.database !== place.database || next.schema !== place.schema) {
          if (place.database !== undefined || place.schema !== undefined) setObject(null);
        }
      }}
      selected={object?.name ?? null}
      onSelect={(next) => {
        setObject(next);
        setObjectToRestore(null);
        setJump(null);
        setTab((current) => (current === "query" ? "data" : current));
      }}
      onBack={() =>
        void leaveAllowed().then((sure) => {
          if (!sure) return;
          setObjectToRestore(null);
          setConnectionId(null);
        })
      }
      onEdit={() => setEditing(connection)}
      onQuery={openQuery}
    />
  ) : (
    <ConnectionList connections={list} loading={connections.isLoading} error={connections.error ? errorText(connections.error) : null} onChoose={choose} onAdd={() => setEditing("new")} onEdit={setEditing} onAgentActivity={() => setAgentRequestsOpen(true)} />
  );

  const showContent = connection !== null && !connection.needsPassword && (object !== null || tab === "query");
  const content = connection && showContent ? <Content connection={connection} place={place} object={object} tab={tab} setTab={setTab} prefill={queryPrefill} onPrefillUsed={() => setQueryPrefill(null)} jump={jump} onJump={followForeignKey} onBack={() => (tab === "query" && !object ? setTab("data") : setObject(null))} onDropped={() => setObject(null)} /> : null;

  return (
    <View style={ui.root}>
      {waitingRequests > 0 ? (
        <View style={[ui.toolbar, { backgroundColor: ui.colors.surface1 }]}>
          <Text style={ui.warning}>
            {waitingRequests} agent request{waitingRequests === 1 ? "" : "s"} waiting. Nothing is written until you approve.
          </Text>
          <Btn label="Review" on onPress={() => setAgentRequestsOpen(true)} />
        </View>
      ) : null}
      {agentRequestsOpen ? (
        <AgentRequestsModal
          onClose={() => setAgentRequestsOpen(false)}
          onReview={(requestId, reviewedId, values) => {
            setAgentRequestsOpen(false);
            setReviewing({ requestId, connectionId: reviewedId, values });
          }}
        />
      ) : null}
      {reviewing ? (
        <ConnectionForm
          connection={list.find((item) => item.id === reviewing.connectionId) ?? null}
          proposal={{ requestId: reviewing.requestId, values: reviewing.values }}
          note={proposalNote(reviewing.values, list.find((item) => item.id === reviewing.connectionId) ?? null)}
          onClose={() => setReviewing(null)}
          onSaved={() => {
            setReviewing(null);
            void connections.refetch();
          }}
          onDeleted={() => {
            setReviewing(null);
            void connections.refetch();
          }}
        />
      ) : null}
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
            if (saved.id !== connectionId) choose(saved);
          }}
          onDeleted={(id) => {
            setEditing(null);
            if (id === connectionId) {
              pending.clearAll();
              setConnectionId(null);
            }
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

function Content({ connection, place, object, tab, setTab, prefill, onPrefillUsed, jump, onJump, onBack, onDropped }: { connection: ConnectionView; place: Place; object: ObjectInfo | null; tab: Tab; setTab: (tab: Tab) => void; prefill: { text: string; revision: number } | null; onPrefillUsed: () => void; jump: { object: string; filters: Filter[]; revision: number } | null; onJump: (target: JumpTarget) => void; onBack: () => void; onDropped: () => void }) {
  const ui = useUi();
  const info = ENGINES[connection.engine];
  const scope = { connectionId: connection.id, ...place };
  const ref = object ? { ...scope, name: object.name } : null;
  const activeJump = jump && jump.object === object?.name ? jump : null;
  const bar = connectionColorValue(ui.colors, connection.color);
  // The connection's name is out of view on a phone, and a production warning must say which one it means.
  const pills = (
    <>
      {connection.environment === "production" ? <Pill text={ui.compact ? `Production: ${connection.name}` : "Production"} kind="danger" detail={`Production: ${connection.name}`} /> : null}
      {connection.safety === "read-only" ? <Pill text="Read-only" /> : null}
      {connection.notEncrypted ? <Pill text="Not encrypted" kind="warning" detail="Not encrypted: this connection sends data and its password in the clear." /> : null}
    </>
  );
  const hasPills = connection.environment === "production" || connection.safety === "read-only" || connection.notEncrypted;
  const tabs: { label: string; value: Tab }[] = [...(ref ? [{ label: "Data", value: "data" as const }, { label: "Structure", value: "structure" as const }] : []), { label: info.queryLanguage === "SQL" ? "SQL" : "Query", value: "query" }];
  return (
    <View style={{ flex: 1, minHeight: 0, borderTopWidth: bar ? 3 : 0, borderTopColor: bar ?? "transparent" }}>
      <View style={[ui.toolbar, { justifyContent: "space-between" }]}>
        <View style={[ui.row, { flexShrink: 1, minWidth: 0 }]}>
          {ui.compact ? <Btn icon="ArrowLeft" title="Back" onPress={onBack} /> : null}
          <Text numberOfLines={1} style={[ui.title, { flexShrink: 1 }]}>
            {tab === "query" ? "Query" : object?.name}
          </Text>
          {ui.compact ? null : pills}
        </View>
        {tabs.length > 1 ? <Segmented label="View" value={tab} options={tabs} onChange={setTab} /> : null}
      </View>
      {ui.compact && hasPills ? <View style={[ui.wrap, { paddingHorizontal: 8, paddingVertical: 5 }]}>{pills}</View> : null}
      {tab === "data" && ref ? <DataTab key={`${JSON.stringify(ref)}:${activeJump?.revision ?? ""}`} connection={connection} refObject={ref} initialFilters={activeJump?.filters} onJump={onJump} /> : null}
      {tab === "structure" && ref ? <StructureTab key={JSON.stringify(ref)} connection={connection} refObject={ref} onDropped={onDropped} /> : null}
      {/* Kept mounted, so moving between tabs does not lose the text or the results. */}
      <View style={{ flex: tab === "query" ? 1 : 0, minHeight: 0, display: tab === "query" ? "flex" : "none" }}>
        <QueryWorkspace key={connection.id} connection={connection} scope={scope} prefill={prefill} onPrefillUsed={onPrefillUsed} />
      </View>
    </View>
  );
}
