import { FlatList, Icon } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { parseConnectionUrl } from "../shared/connection-url";
import { rowAccessPossible } from "../shared/agent-access";
import type { AgentAccess, AgentRowAccess, ConnectionColor, ConnectionInput, ConnectionView, EnvironmentLabel, SafetyMode, TlsMode } from "../shared/contracts";
import { ENGINE_IDS, ENGINES, type EngineId, FIELD_LABELS } from "../shared/engines";
import { Btn, Chip, connectionColorValue, errorText, Field, Message, Modal, Pill, PinnedFooter, Section, Segmented, Select, useApi, useConfirm, useUi } from "./kit";
import { usePreferences } from "./preferences";

const SAFETY_TEXT: Record<SafetyMode, string> = {
  "read-only": "Refuses anything that could write. A database user without write rights is the only full guarantee.",
  confirm: "Shows each change and asks first. A function called from a SELECT can still write without asking.",
  open: "Runs changes straight away.",
};
const TLS_TEXT: Record<TlsMode, string> = {
  off: "No encryption: data and the password are sent in the clear.",
  require: "Encrypted, but the server's certificate is not checked.",
  verify: "Encrypted, and the certificate and host name are checked.",
};

const ROW_ACCESS_TEXT: Record<AgentRowAccess, string> = {
  none: "Agents get names and types only.",
  read: "Every agent can read rows here without asking you. Row data goes to the agent's provider and stays in that chat. Rows can hold text someone else wrote, and an agent with a shell could act on it, including writing to this database directly.",
  propose: "Agents can also propose changes. Each one waits for you to approve it in Datawise, in every agent mode. This guards these tools only. A database user without write rights is the only full guarantee.",
};

const TLS_LABELS: Record<TlsMode, string> = { off: "Off", require: "Required", verify: "Verified" };
const AGENT_SUMMARY: Record<AgentRowAccess, string> = { none: "Names only", read: "Names and rows", propose: "Names, rows, proposals" };

const ENVIRONMENTS: { value: EnvironmentLabel; label: string }[] = [
  { value: "none", label: "None" },
  { value: "development", label: "Development" },
  { value: "staging", label: "Staging" },
  { value: "production", label: "Production" },
];
const COLORS: ConnectionColor[] = ["red", "amber", "green", "gray", "contrast"];

type ListRow = { kind: "group"; title: string } | { kind: "connection"; connection: ConnectionView };

// Named groups in order, then connections with no group, under a heading only when groups exist.
function listRows(connections: ConnectionView[]): ListRow[] {
  const groups = [...new Set(connections.map((item) => item.group).filter(Boolean))].sort((left, right) => left.localeCompare(right));
  if (groups.length === 0) return connections.map((connection) => ({ kind: "connection", connection }));
  const rows: ListRow[] = [];
  for (const title of [...groups, ""]) {
    const members = connections.filter((item) => item.group === title);
    if (members.length === 0) continue;
    rows.push({ kind: "group", title: title || "No group" });
    for (const connection of members) rows.push({ kind: "connection", connection });
  }
  return rows;
}

function isLoopback(host: string): boolean {
  return host === "" || host === "localhost" || host === "::1" || host.startsWith("127.");
}

export function ConnectionList({ connections, loading, error, onChoose, onAdd, onEdit, onAgentActivity }: { connections: ConnectionView[]; loading: boolean; error: string | null; onChoose: (connection: ConnectionView) => void; onAdd: () => void; onEdit: (connection: ConnectionView) => void; onAgentActivity: () => void }) {
  const ui = useUi();
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={[ui.toolbar, { justifyContent: "space-between" }]}>
        <Text style={ui.title}>Connections</Text>
        <View style={ui.row}>
          <Btn icon="Bot" label="Agents" onPress={onAgentActivity} />
          <Btn icon="Plus" label="Add" kind="primary" onPress={onAdd} />
        </View>
      </View>
      {error ? <View style={{ padding: 12 }}><Message kind="error" text={error} /></View> : null}
      {!loading && !error && connections.length === 0 ? <View style={{ padding: 12 }}><Message kind="note" text="No connections yet." /></View> : null}
      <FlatList
        style={{ flex: 1, minHeight: 0 }}
        data={listRows(connections)}
        keyExtractor={(row) => (row.kind === "group" ? `group:${row.title}` : row.connection.id)}
        renderItem={({ item: row }) => {
          if (row.kind === "group") {
            return (
              <View style={{ paddingHorizontal: 12, paddingTop: 12, paddingBottom: 4 }}>
                <Text style={ui.label}>{row.title}</Text>
              </View>
            );
          }
          const item = row.connection;
          const bar = connectionColorValue(ui.colors, item.color);
          return (
            <View style={{ flexDirection: "row", alignItems: "center", borderLeftWidth: bar ? 3 : 0, borderLeftColor: bar ?? "transparent" }}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Open ${item.name}`} onPress={() => onChoose(item)} style={({ pressed }) => ({ flex: 1, minWidth: 0, paddingHorizontal: 12, paddingVertical: 8, gap: 3, backgroundColor: pressed ? ui.colors.surface1 : "transparent" })}>
                <Text numberOfLines={1} style={ui.body}>
                  {item.name}
                </Text>
                <Text numberOfLines={1} style={ui.muted}>
                  {[ENGINES[item.engine].label, item.environment === "staging" ? "Staging" : item.environment === "development" ? "Development" : "", item.safety === "read-only" ? "Read-only" : "", item.host || item.file].filter(Boolean).join(" · ")}
                </Text>
                {item.environment === "production" || item.notEncrypted ? (
                  <View style={ui.wrap}>
                    {item.environment === "production" ? <Pill text="Production" kind="danger" /> : null}
                    {item.notEncrypted ? <Pill text="Not encrypted" kind="warning" /> : null}
                  </View>
                ) : null}
              </Pressable>
              <View style={{ paddingRight: 6 }}>
                <Btn icon="Settings2" title={`Edit ${item.name}`} onPress={() => onEdit(item)} />
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}

export function UnlockPrompt({ connection, onDone, onCancel }: { connection: ConnectionView; onDone: () => void; onCancel: () => void }) {
  const ui = useUi();
  const api = useApi();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Password for ${connection.name}`} icon={<Icon name="LockKeyhole" size={16} color={ui.colors.foreground} />} open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <Modal.Content>
        <Text style={ui.muted}>This connection keeps its password in memory until Paseo restarts.</Text>
        <Field label="Password" value={password} onChangeText={setPassword} secure />
        {error ? <Message kind="error" text={error} /> : null}
        <View style={[ui.row, { justifyContent: "flex-end" }]}>
          <Btn label="Cancel" onPress={onCancel} />
          <Btn
            label="Connect"
            kind="primary"
            disabled={password === ""}
            onPress={() => {
              api.unlockConnection({ id: connection.id, password }).then(onDone, (failure: unknown) => setError(errorText(failure)));
            }}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

type Draft = Required<Pick<ConnectionInput, "name" | "engine" | "host" | "user" | "database" | "file" | "serviceName" | "localDataCenter" | "region" | "endpoint" | "accessKeyId" | "authSource" | "caCertificate" | "rememberPassword">> & { port: string; tls: TlsMode; safety: SafetyMode; environment: EnvironmentLabel; color: ConnectionColor | null; group: string; agentAccess: AgentAccess; agentRowAccess: AgentRowAccess; useSsh: boolean; sshHost: string; sshPort: string; sshUser: string };

export type ConnectionPrefill = Partial<Pick<Draft, "name" | "engine" | "file" | "safety">>;

function emptyDraft(safety: SafetyMode): Draft {
  return { environment: "none", color: null, group: "", agentAccess: "none", agentRowAccess: "none", name: "", engine: "postgres", host: "localhost", port: "", user: "", database: "", file: "", serviceName: "", localDataCenter: "", region: "", endpoint: "", accessKeyId: "", authSource: "", caCertificate: "", rememberPassword: true, tls: "off", safety, useSsh: false, sshHost: "", sshPort: "22", sshUser: "" };
}

function toDraft(connection: ConnectionView): Draft {
  return { environment: connection.environment, color: connection.color, group: connection.group, agentAccess: connection.agentAccess, agentRowAccess: connection.agentRowAccess, name: connection.name, engine: connection.engine, host: connection.host, port: connection.port === null ? "" : String(connection.port), user: connection.user, database: connection.database, file: connection.file, serviceName: connection.serviceName, localDataCenter: connection.localDataCenter, region: connection.region, endpoint: connection.endpoint, accessKeyId: connection.accessKeyId, authSource: connection.authSource, caCertificate: connection.caCertificate, rememberPassword: connection.rememberPassword, tls: connection.tls, safety: connection.safety, useSsh: connection.ssh !== null, sshHost: connection.ssh?.host ?? "", sshPort: String(connection.ssh?.port ?? 22), sshUser: connection.ssh?.user ?? "" };
}

export function ConnectionForm({ connection, prefill, note, onClose, onSaved, onDeleted }: { connection: ConnectionView | null; prefill?: ConnectionPrefill; note?: string; onClose: () => void; onSaved: (saved: ConnectionView) => void; onDeleted: (id: string) => void }) {
  const ui = useUi();
  const api = useApi();
  const ask = useConfirm();
  const preferences = usePreferences();
  // The preference applies only here. A stored connection never takes its write mode from a preference.
  const [draft, setDraft] = useState<Draft>(() => (connection ? toDraft(connection) : { ...emptyDraft(preferences.newConnectionSafety), ...prefill }));
  const [url, setUrl] = useState("");
  const [urlOpen, setUrlOpen] = useState(false);
  const [tlsTouched, setTlsTouched] = useState(connection !== null);
  // undefined keeps what is saved, "" clears it on save, other text replaces it.
  const [password, setPassword] = useState<string | undefined>();
  const [apiKey, setApiKey] = useState<string | undefined>();
  const [sshPassword, setSshPassword] = useState<string | undefined>();
  const [sshKey, setSshKey] = useState<string | undefined>();
  const [sshPassphrase, setSshPassphrase] = useState<string | undefined>();
  const [fingerprint, setFingerprint] = useState(connection?.sshHostFingerprint ?? null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const info = ENGINES[draft.engine];
  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const setHost = (host: string) => set(tlsTouched ? { host } : { host, tls: isLoopback(host) ? "off" : "verify" });
  const has = (field: (typeof info.fields)[number]) => info.fields.includes(field);

  const applyUrl = (text: string) => {
    setUrl(text);
    const parsed = parseConnectionUrl(text);
    if (!parsed) return;
    set({ engine: parsed.engine, host: parsed.host, port: parsed.port === null ? "" : String(parsed.port), user: parsed.user, database: parsed.database, tls: parsed.useTls ? "verify" : isLoopback(parsed.host) ? "off" : "verify", name: draft.name || parsed.host });
    setTlsTouched(true);
    if (parsed.password) setPassword(parsed.password);
  };

  const namesAllowed = info.catalogSchema && draft.environment !== "production";
  const rowsAllowed = namesAllowed && draft.agentAccess === "schema" && rowAccessPossible(draft.engine, draft.environment);

  const build = (): ConnectionInput => ({
    id: connection?.id,
    name: draft.name.trim() || info.label,
    engine: draft.engine,
    host: has("host") ? draft.host.trim() : "",
    port: has("port") && draft.port !== "" ? Number(draft.port) : null,
    user: has("user") ? draft.user : "",
    database: has("database") ? draft.database : "",
    file: has("file") ? draft.file.trim() : "",
    serviceName: draft.serviceName,
    localDataCenter: draft.localDataCenter,
    region: draft.region,
    endpoint: draft.endpoint,
    accessKeyId: draft.accessKeyId,
    authSource: draft.authSource,
    tls: info.supportsTls ? draft.tls : "off",
    caCertificate: draft.caCertificate,
    safety: draft.safety,
    environment: draft.environment,
    color: draft.color,
    group: draft.group.trim(),
    agentAccess: namesAllowed ? draft.agentAccess : "none",
    agentRowAccess: !rowsAllowed ? "none" : draft.agentRowAccess === "propose" && draft.safety === "read-only" ? "read" : draft.agentRowAccess,
    // An engine with no password field has nothing to ask for after a restart.
    rememberPassword: has("password") ? draft.rememberPassword : true,
    ssh: draft.useSsh && info.supportsSsh ? { host: draft.sshHost.trim(), port: Number(draft.sshPort) || 22, user: draft.sshUser } : null,
    password,
    apiKey,
    sshPassword,
    sshPrivateKey: sshKey,
    sshPassphrase,
  });

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setResult(null);
    try {
      await work();
    } catch (error) {
      setResult({ kind: "error", text: errorText(error) });
    } finally {
      setBusy(false);
    }
  };

  const test = () =>
    run(async () => {
      const answer = await api.testConnection(build());
      if (answer.ok) setResult({ kind: "success", text: `Connected in ${answer.latencyMs} ms: ${answer.serverVersion}${answer.sshHostFingerprint ? `\nSSH host key: ${answer.sshHostFingerprint}` : ""}` });
      else setResult({ kind: "error", text: answer.error ?? "Could not connect." });
    });
  const save = () => run(async () => onSaved(await api.saveConnection(build())));
  const remove = () =>
    run(async () => {
      if (!connection) return;
      const ok = await ask({ title: "Delete connection", preview: connection.name, reason: "This removes the saved connection, its history and its saved queries. The database is not touched.", actionLabel: "Delete" });
      if (!ok) return;
      await api.deleteConnection({ id: connection.id });
      onDeleted(connection.id);
    });
  const secretHint = (saved: boolean | undefined) => (saved ? "Saved. Leave blank to keep it." : undefined);

  const remote = has("host") && !isLoopback(draft.host.trim());
  // The same rule the server uses for its "not encrypted" warning.
  const unencrypted = (info.supportsTls ? draft.tls : "off") === "off" && !(info.supportsSsh && draft.useSsh) && remote;
  const securitySummary = [unencrypted ? "Not encrypted" : info.supportsTls ? `Encryption ${TLS_LABELS[draft.tls].toLowerCase()}` : "", info.supportsSsh ? (draft.useSsh ? "Through SSH" : "Direct") : ""].filter(Boolean).join(" · ");
  const hasSecurity = info.supportsTls || info.supportsSsh;
  const agentSummary = draft.agentAccess === "none" ? "No access" : AGENT_SUMMARY[rowsAllowed ? (draft.agentRowAccess === "propose" && draft.safety === "read-only" ? "read" : draft.agentRowAccess) : "none"];
  const shares = namesAllowed && draft.agentAccess === "schema" && rowsAllowed && draft.agentRowAccess !== "none";

  const footer = (
    <>
      {result ? <Message kind={result.kind} text={result.text} /> : null}
      <View style={[ui.row, { justifyContent: "space-between" }]}>
        {connection ? <Btn label="Delete" kind="danger" disabled={busy} onPress={() => void remove()} /> : <View />}
        <View style={ui.row}>
          <Btn label={busy ? "Working…" : "Test"} disabled={busy} onPress={() => void test()} />
          <Btn label="Save" kind="primary" disabled={busy} onPress={() => void save()} />
        </View>
      </View>
    </>
  );

  return (
    <Modal title={connection ? `Edit ${connection.name}` : "Add connection"} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content scrollable={false} contentContainerStyle={{ padding: 0, gap: 0 }}>
        <PinnedFooter footer={footer}>
          {note ? <Message kind="warning" text={note} /> : null}
          {connection || prefill ? null : urlOpen ? (
            <Field label="Connection URL" value={url} onChangeText={applyUrl} placeholder="postgres://user:password@host:5432/db" secure={url.includes("@")} />
          ) : (
            <View style={{ alignSelf: "flex-start" }}>
              <Btn icon="Link" label="Paste a connection URL" onPress={() => setUrlOpen(true)} />
            </View>
          )}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Field label="Name" value={draft.name} onChangeText={(name) => set({ name })} placeholder={info.label} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
              <Text style={ui.label}>Database type</Text>
              <Select label="Database type" value={draft.engine} options={ENGINE_IDS.map((id: EngineId) => ({ label: ENGINES[id].label, value: id, detail: `Also works with ${ENGINES[id].alsoWorksWith}` }))} onChange={(id) => set({ engine: id as EngineId, port: "" })} />
            </View>
          </View>
          {has("file") ? <Field label={FIELD_LABELS.file} value={draft.file} onChangeText={(file) => set({ file })} placeholder="/path/to/data.db" mono /> : null}
          {has("host") ? (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <View style={{ flex: 3, minWidth: 0 }}><Field label={FIELD_LABELS.host} value={draft.host} onChangeText={setHost} /></View>
              <View style={{ flex: 1, minWidth: 0 }}><Field label={FIELD_LABELS.port} value={draft.port} onChangeText={(port) => set({ port: port.replace(/\D/g, "") })} placeholder={String(info.defaultPort ?? "")} /></View>
            </View>
          ) : null}
          {has("region") ? <Field label={FIELD_LABELS.region} value={draft.region} onChangeText={(region) => set({ region })} placeholder="us-east-1" /> : null}
          {has("endpoint") ? <Field label={FIELD_LABELS.endpoint} value={draft.endpoint} onChangeText={(endpoint) => set({ endpoint })} /> : null}
          {has("accessKeyId") ? <Field label={FIELD_LABELS.accessKeyId} value={draft.accessKeyId} onChangeText={(accessKeyId) => set({ accessKeyId })} /> : null}
          {has("serviceName") ? <Field label={FIELD_LABELS.serviceName} value={draft.serviceName} onChangeText={(serviceName) => set({ serviceName })} placeholder="FREEPDB1" /> : null}
          {has("localDataCenter") ? <Field label={FIELD_LABELS.localDataCenter} value={draft.localDataCenter} onChangeText={(localDataCenter) => set({ localDataCenter })} placeholder="datacenter1" /> : null}
          {has("user") || has("password") ? (
            <View style={{ flexDirection: "row", gap: 8 }}>
              {has("user") ? <View style={{ flex: 1, minWidth: 0 }}><Field label={FIELD_LABELS.user} value={draft.user} onChangeText={(user) => set({ user })} /></View> : null}
              {has("password") ? <View style={{ flex: 1, minWidth: 0 }}><Field label={has("accessKeyId") ? "Secret access key" : FIELD_LABELS.password} value={password ?? ""} onChangeText={setPassword} secure hint={secretHint(connection?.hasPassword)} /></View> : null}
            </View>
          ) : null}
          {has("password") ? (
            <View style={{ gap: 4 }}>
              <Segmented label="Password storage" value={draft.rememberPassword ? "saved" : "session"} options={[{ label: "Remember password", value: "saved" }, { label: "This session only", value: "session" }]} onChange={(next) => set({ rememberPassword: next === "saved" })} />
              <Text style={ui.muted}>{draft.rememberPassword ? "Stored in a file only your user can read. Agents you run as this user can read it too." : "Kept in memory, and asked for again after Paseo restarts. SSH secrets and API keys are still stored in the file."}</Text>
            </View>
          ) : null}
          {has("apiKey") ? <Field label={FIELD_LABELS.apiKey} value={apiKey ?? ""} onChangeText={setApiKey} secure hint={secretHint(connection?.hasApiKey)} /> : null}
          {has("database") ? <Field label={FIELD_LABELS.database} value={draft.database} onChangeText={(database) => set({ database })} /> : null}
          {has("authSource") ? <Field label={FIELD_LABELS.authSource} value={draft.authSource} onChangeText={(authSource) => set({ authSource })} placeholder="admin" /> : null}

          <View style={{ gap: 4 }}>
            <Text style={ui.label}>Environment</Text>
            <Segmented label="Environment" value={draft.environment} options={ENVIRONMENTS} onChange={(environment) => set(environment === "production" ? { environment, agentAccess: "none", safety: draft.safety === "open" ? "confirm" : draft.safety } : { environment })} />
            {draft.environment === "production" ? <Text style={ui.muted}>Labels every tab. No prompts and agent access are not allowed.</Text> : draft.environment === "none" && remote ? <Text style={ui.muted}>Datawise does not guess this from the host. Choose Production for a live database: it blocks No prompts and agent access.</Text> : null}
          </View>

          <View style={{ gap: 4 }}>
            <Text style={ui.label}>When writing</Text>
            <Segmented label="When writing" value={draft.safety} options={[{ label: "Read-only", value: "read-only" as const }, { label: "Ask first", value: "confirm" as const }, ...(draft.environment === "production" ? [] : [{ label: "No prompts", value: "open" as const }])]} onChange={(safety) => set({ safety })} />
            <Text style={ui.muted}>{SAFETY_TEXT[draft.safety]}</Text>
          </View>

          <View>
            {hasSecurity ? (
              <Section title="Security" value={securitySummary} warn={unencrypted}>
                {info.supportsTls ? (
                  <View style={{ gap: 4 }}>
                    <Text style={ui.label}>Encryption</Text>
                    <Segmented
                      label="Encryption"
                      value={draft.tls}
                      options={(["off", "require", "verify"] as const).map((mode) => ({ label: TLS_LABELS[mode], value: mode }))}
                      onChange={(tls) => {
                        setTlsTouched(true);
                        set({ tls });
                      }}
                    />
                    <Text style={ui.muted}>{TLS_TEXT[draft.tls]}</Text>
                    {draft.tls === "verify" ? <Field label="CA certificate (optional, PEM text)" value={draft.caCertificate} onChangeText={(caCertificate) => set({ caCertificate })} multiline mono /> : null}
                  </View>
                ) : null}
                {info.supportsSsh ? (
                  <View style={{ gap: 8 }}>
                    <View style={{ gap: 4 }}>
                      <Text style={ui.label}>Route</Text>
                      <Segmented label="Route" value={draft.useSsh ? "ssh" : "direct"} options={[{ label: "Direct", value: "direct" }, { label: "Through SSH", value: "ssh" }]} onChange={(next) => set({ useSsh: next === "ssh" })} />
                    </View>
                    {draft.useSsh ? (
                      <>
                        <View style={{ flexDirection: "row", gap: 8 }}>
                          <View style={{ flex: 3, minWidth: 0 }}><Field label="SSH host" value={draft.sshHost} onChangeText={(sshHost) => set({ sshHost })} /></View>
                          <View style={{ flex: 1, minWidth: 0 }}><Field label="Port" value={draft.sshPort} onChangeText={(sshPort) => set({ sshPort: sshPort.replace(/\D/g, "") })} /></View>
                        </View>
                        <Field label="SSH user" value={draft.sshUser} onChangeText={(sshUser) => set({ sshUser })} />
                        <Field label="SSH password" value={sshPassword ?? ""} onChangeText={setSshPassword} secure hint={secretHint(connection?.hasSshPassword)} />
                        <Field label="SSH private key (PEM text)" value={sshKey ?? ""} onChangeText={setSshKey} secure multiline mono hint={secretHint(connection?.hasSshPrivateKey)} />
                        <Field label="Key passphrase" value={sshPassphrase ?? ""} onChangeText={setSshPassphrase} secure hint={secretHint(connection?.hasSshPassphrase)} />
                        {fingerprint ? (
                          <View style={ui.wrap}>
                            <Text selectable style={ui.muted}>Trusted host key: {fingerprint}</Text>
                            {connection ? (
                              <Btn
                                label="Forget"
                                onPress={() =>
                                  void run(async () => {
                                    await api.clearSshFingerprint({ id: connection.id });
                                    setFingerprint(null);
                                  })
                                }
                              />
                            ) : null}
                          </View>
                        ) : (
                          <Text style={ui.muted}>The server's key is trusted on first connect and checked after that.</Text>
                        )}
                      </>
                    ) : null}
                  </View>
                ) : null}
              </Section>
            ) : null}

            {namesAllowed ? (
              <Section title="Agents" value={agentSummary} warn={shares}>
                <View style={{ gap: 4 }}>
                  <Text style={ui.label}>Agent access</Text>
                  <Segmented label="Agent access" value={draft.agentAccess} options={[{ label: "No access", value: "none" as const }, { label: "Table and column names", value: "schema" as const }]} onChange={(agentAccess) => set({ agentAccess })} />
                  <Text style={ui.muted}>
                    {draft.agentAccess === "schema" ? "Every agent can read this connection's table names, column names and types. Names can hold text someone else wrote. Turning this on or off makes open agent sessions reopen before their next prompt. Agents only get this while Paseo's \"Enable Paseo tools\" host setting is on." : "Agents cannot see this connection through Datawise."}
                  </Text>
                </View>
                {rowsAllowed ? (
                  <View style={{ gap: 4 }}>
                    <Text style={ui.label}>Agents and rows</Text>
                    <Segmented label="Agents and rows" value={draft.agentRowAccess === "propose" && draft.safety === "read-only" ? "read" : draft.agentRowAccess} options={[{ label: "No rows", value: "none" as const }, { label: "Read rows", value: "read" as const }, ...(draft.safety === "read-only" ? [] : [{ label: "Propose changes", value: "propose" as const }])]} onChange={(agentRowAccess) => set({ agentRowAccess })} />
                    <Text style={ui.muted}>{ROW_ACCESS_TEXT[draft.agentRowAccess === "propose" && draft.safety === "read-only" ? "read" : draft.agentRowAccess]}</Text>
                  </View>
                ) : draft.agentAccess === "schema" && ENGINES[draft.engine].transactionalEdits ? (
                  <Text style={ui.muted}>To share rows, label this connection Development or Staging.</Text>
                ) : null}
              </Section>
            ) : null}

            <Section title="Color and group" value={[draft.color ? draft.color[0]?.toUpperCase() + draft.color.slice(1) : "No color", draft.group.trim()].filter(Boolean).join(" · ")}>
              <View style={{ gap: 4 }}>
                <Text style={ui.label}>Color</Text>
                <View style={ui.wrap}>
                  <Chip label="None" on={draft.color === null} onPress={() => set({ color: null })} />
                  {COLORS.map((color) => (
                    <Pressable key={color} accessibilityRole="button" accessibilityLabel={`Color ${color}`} accessibilityState={{ selected: draft.color === color }} onPress={() => set({ color })} style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: connectionColorValue(ui.colors, color) ?? "transparent", borderWidth: draft.color === color ? 3 : 0, borderColor: ui.colors.foreground }} />
                  ))}
                </View>
              </View>
              <Field label="Group" value={draft.group} onChangeText={(group) => set({ group: group.slice(0, 60) })} placeholder="Optional, such as a project name" />
            </Section>
          </View>
        </PinnedFooter>
      </Modal.Content>
    </Modal>
  );
}
