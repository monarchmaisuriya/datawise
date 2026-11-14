import { FlatList, ScrollView } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { visibleText, visibleValue } from "../shared/agent-display";
import type { AgentRequestItem, AgentRequestSummary, ConnectionProposal, RowKey } from "../shared/contracts";
import { Btn, errorText, Field, Message, Modal, useApi, useUi } from "./kit";

const POLL_MS = 5000;

function rowsText(count: number): string {
  return `${count} row${count === 1 ? "" : "s"}`;
}

function sizeText(request: AgentRequestSummary): string {
  if (request.headline) return visibleText(request.headline);
  return request.unit === "statements" ? `run ${request.rows} statement${request.rows === 1 ? "" : "s"}` : `change ${rowsText(request.rows)}`;
}

export function usePendingAgentRequests() {
  const api = useApi();
  const list = useQuery({ queryKey: ["datawise", "agent-requests"], queryFn: () => api.listAgentRequests({}), refetchInterval: POLL_MS, retry: false });
  return (list.data?.requests ?? []).filter((request) => request.status === "pending").length;
}

function KeyText({ value }: { value: RowKey }) {
  const ui = useUi();
  return (
    <Text selectable style={ui.mono}>
      {Object.entries(value)
        .map(([name, cell]) => `${visibleText(name)} = ${visibleValue(cell)}`)
        .join(", ")}
    </Text>
  );
}

// Each change gets its own card, and every value goes through visibleValue, so a value cannot pass for another change.
function ItemCard({ item }: { item: AgentRequestItem }) {
  const ui = useUi();
  if (item.kind === "insert") {
    return (
      <View style={ui.card}>
        <Text style={ui.label}>Add a row</Text>
        {Object.entries(item.values).map(([name, value]) => (
          <Text key={name} selectable style={ui.mono}>
            {visibleText(name)} = {visibleValue(value)}
          </Text>
        ))}
      </View>
    );
  }
  if (item.kind === "statement") {
    return (
      <View style={ui.card}>
        <Text style={ui.label}>Run this statement</Text>
        <Text selectable style={ui.mono}>
          {visibleText(item.text)}
        </Text>
      </View>
    );
  }
  if (item.kind === "field") {
    return (
      <View style={ui.card}>
        <Text style={ui.label}>{item.label}</Text>
        <Text selectable style={ui.mono}>
          {visibleText(item.value)}
        </Text>
      </View>
    );
  }
  if (item.kind === "delete") {
    return (
      <View style={[ui.card, { borderColor: ui.colors.statusDanger }]}>
        <Text style={ui.danger}>Delete this row</Text>
        <KeyText value={item.key} />
        {Object.entries(item.row).map(([name, value]) => (
          <Text key={name} selectable style={ui.mono}>
            {visibleText(name)} = {visibleValue(value)}
          </Text>
        ))}
      </View>
    );
  }
  return (
    <View style={ui.card}>
      <Text style={ui.label}>Change the row where</Text>
      <KeyText value={item.key} />
      {item.changes.map((change) => (
        <View key={change.column} style={{ gap: 2, paddingTop: 4 }}>
          <Text style={ui.label}>{visibleText(change.column)}</Text>
          <Text selectable style={ui.muted}>
            now: {visibleValue(change.before)}
          </Text>
          <Text selectable style={ui.mono}>
            new: {visibleValue(change.after)}
          </Text>
        </View>
      ))}
    </View>
  );
}

export type ReviewConnection = (requestId: string, connectionId: string | null, values: ConnectionProposal) => void;

function RequestDetail({ id, onBack, onReview }: { id: string; onBack: () => void; onReview: ReviewConnection }) {
  const ui = useUi();
  const api = useApi();
  const client = useQueryClient();
  const detail = useQuery({ queryKey: ["datawise", "agent-request", id], queryFn: () => api.getAgentRequest({ id }), retry: false, gcTime: 0, refetchInterval: 2000 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState("");
  const decide = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.decideAgentRequest({ id, approve, confirmName: approve && detail.data?.typeToConfirm ? typed : undefined });
      await client.invalidateQueries({ queryKey: ["datawise", "agent-requests"] });
      await detail.refetch();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const request = detail.data?.request;
  const items = detail.data?.items ?? [];
  // Open tables are not read again on return to Paseo, so an approved change refreshes them when it lands.
  // Only on that change: opening a request that finished earlier reads nothing.
  const status = request?.status;
  const seen = useRef(status);
  useEffect(() => {
    const before = seen.current;
    seen.current = status;
    if (before !== undefined && before !== status && (status === "done" || status === "unknown")) void client.invalidateQueries({ queryKey: ["datawise", "rows"] });
  }, [status, client]);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ alignSelf: "flex-start" }}>
        <Btn icon="ArrowLeft" label="All requests" onPress={onBack} />
      </View>
      {detail.error ? <Message kind="error" text={errorText(detail.error)} /> : null}
      {request ? (
        <>
          <Text style={ui.title}>{visibleText(request.agentTitle ?? "An agent")} wants to {sizeText(request)}</Text>
          <Text selectable style={ui.muted}>
            Agent {visibleText(request.agentId)}
          </Text>
          <Text selectable style={request.environment === "production" ? ui.danger : ui.body}>
            {visibleText(request.connectionName)} ({request.environment}), {visibleText(request.place)}
          </Text>
          {items.some((item) => item.kind === "delete") ? <Message kind="warning" text="Deleting a row can also remove rows in other tables, if foreign keys cascade." /> : null}
          {items.map((item, index) => (
            <ItemCard key={index} item={item} />
          ))}
          {request.message ? <Message kind={request.status === "failed" ? "error" : "note"} text={request.message} /> : null}
          {error ? <Message kind="error" text={error} /> : null}
          {request.status === "pending" && detail.data?.typeToConfirm ? (
            <>
              <Text style={ui.danger}>This cannot be undone. Type {visibleText(detail.data.typeToConfirm)} to approve.</Text>
              <Field label="Name" value={typed} onChangeText={setTyped} mono />
            </>
          ) : null}
          {request.status === "pending" ? (
            <View style={[ui.row, { justifyContent: "flex-end" }]}>
              <Btn label="Reject" disabled={busy} onPress={() => void decide(false)} />
              {request.kind === "connection" ? (
                <Btn label="Review in form" kind="primary" disabled={busy} onPress={() => onReview(request.id, request.connectionId || null, detail.data?.connectionProposal ?? {})} />
              ) : (
                <Btn label={busy ? "Working…" : "Approve"} kind={detail.data?.typeToConfirm ? "danger" : "primary"} disabled={busy || (detail.data?.typeToConfirm ? typed !== detail.data.typeToConfirm : false)} onPress={() => void decide(true)} />
              )}
            </View>
          ) : (
            <Message kind={request.status === "done" ? "success" : request.status === "unknown" || request.status === "partial" ? "warning" : "note"} text={request.status === "partial" ? "Some statements ran before one failed, and those stay applied. Check the data." : request.status === "unknown" ? "Datawise lost the database's answer while committing, so this may or may not have landed. Check the table." : request.status === "done" && request.headline ? `Done: ${visibleText(request.headline)}.` : `This request is ${request.status}${request.status === "done" ? `: ${rowsText(request.affected ?? 0)} changed` : ""}.`} />
          )}
        </>
      ) : null}
    </View>
  );
}

function RequestRow({ request, onOpen }: { request: AgentRequestSummary; onOpen: () => void }) {
  const ui = useUi();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open request from ${request.agentTitle ?? "an agent"}`} onPress={onOpen} style={[ui.card, { gap: 2 }]}>
      <Text numberOfLines={1} style={ui.body}>
        {visibleText(request.agentTitle ?? "An agent")}: {request.headline ? visibleText(request.headline) : `${request.unit === "statements" ? `${request.rows} statement${request.rows === 1 ? "" : "s"}` : rowsText(request.rows)}, ${visibleText(request.place)}`}
      </Text>
      <Text numberOfLines={1} style={request.status === "pending" ? ui.warning : ui.muted}>
        {visibleText(request.connectionName)}, {request.status}
      </Text>
    </Pressable>
  );
}

export function AgentRequestsModal({ onClose, onReview }: { onClose: () => void; onReview: ReviewConnection }) {
  const ui = useUi();
  const api = useApi();
  const [openId, setOpenId] = useState<string | null>(null);
  const requests = useQuery({ queryKey: ["datawise", "agent-requests"], queryFn: () => api.listAgentRequests({}), refetchInterval: POLL_MS, retry: false });
  const activity = useQuery({ queryKey: ["datawise", "agent-activity"], queryFn: () => api.listAgentActivity({}), refetchInterval: POLL_MS, retry: false, gcTime: 0 });
  const list = requests.data?.requests ?? [];
  const events = activity.data?.events ?? [];
  return (
    <Modal title="Agent requests" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content scrollable={false} contentContainerStyle={{ padding: 0, gap: 0 }}>
        <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: 16, gap: 10 }}>
          {openId ? (
            <RequestDetail id={openId} onBack={() => setOpenId(null)} onReview={onReview} />
          ) : (
            <>
              {requests.error ? <Message kind="error" text={errorText(requests.error)} /> : null}
              {!requests.isLoading && list.length === 0 ? <Message kind="note" text="No requests right now. Agents can only ask on connections you opened to them." /> : null}
              {list.map((request) => (
                <RequestRow key={request.id} request={request} onOpen={() => setOpenId(request.id)} />
              ))}
              <View style={[ui.row, { justifyContent: "space-between", paddingTop: 8 }]}>
                <Text style={ui.label}>Recent agent activity</Text>
                <Btn label="Clear" disabled={events.length === 0} onPress={() => void api.clearAgentActivity({}).then(() => activity.refetch())} />
              </View>
              {events.length === 0 ? <Text style={ui.muted}>Nothing yet.</Text> : null}
              <FlatList
                scrollEnabled={false}
                data={events.slice(0, 100)}
                keyExtractor={(event, index) => `${event.at}-${index}`}
                renderItem={({ item: event }) => (
                  <Text numberOfLines={2} style={[ui.muted, { paddingVertical: 2 }]}>
                    {new Date(event.at).toLocaleString()} · {visibleText(event.agentTitle ?? event.agentId)} · {event.action} · {event.change ? visibleText(event.change) : event.unit === "statements" ? `${event.rows} statement${event.rows === 1 ? "" : "s"}` : rowsText(event.rows)} · {visibleText(event.connectionName)} · {visibleText(event.place)}
                  </Text>
                )}
              />
            </>
          )}
        </ScrollView>
      </Modal.Content>
    </Modal>
  );
}
