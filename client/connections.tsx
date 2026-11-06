import { FlatList, Icon, Modal } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { parseConnectionUrl } from "../shared/connection-url";
import type { AgentAccess, ConnectionColor, ConnectionInput, ConnectionView, EnvironmentLabel, SafetyMode, TlsMode } from "../shared/contracts";
import { ENGINE_IDS, ENGINES, type EngineId, FIELD_LABELS } from "../shared/engines";
import { Btn, Chip, connectionColorValue, errorText, Field, Message, useApi, useConfirm, useUi } from "./kit";
import { usePreferences } from "./preferences";

const SAFETY_TEXT: Record<SafetyMode, string> = {
  "read-only": "Refuses anything that could write. A database user without write rights is the only full guarantee.",
  confirm: "Shows each change and asks first. A function called from a SELECT can still write without asking.",
  open: "Runs changes straight away.",
};
const TLS_TEXT: Record<TlsMode, string> = {
  off: "No encryption.",
  require: "Encrypted, but the server's certificate is not checked.",
  verify: "Encrypted, and the certificate and host name are checked.",
};

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

export function ConnectionList({ connections, loading, error, onChoose, onAdd, onEdit }: { connections: ConnectionView[]; loading: boolean; error: string | null; onChoose: (connection: ConnectionView) => void; onAdd: () => void; onEdit: (connection: ConnectionView) => void }) {
  const ui = useUi();
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={[ui.toolbar, { justifyContent: "space-between" }]}>
        <Text style={ui.title}>Connections</Text>
        <Btn icon="Plus" label="Add" kind="primary" onPress={onAdd} />
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
            <View style={{ flexDirection: "row", alignItems: "center", borderBottomWidth: 1, borderBottomColor: ui.colors.border, borderLeftWidth: bar ? 4 : 0, borderLeftColor: bar ?? "transparent" }}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Open ${item.name}`} onPress={() => onChoose(item)} style={({ pressed }) => ({ flex: 1, minWidth: 0, padding: 12, gap: 2, backgroundColor: pressed ? ui.colors.surface1 : "transparent" })}>
                <Text numberOfLines={1} style={ui.body}>
                  {item.name}
                </Text>
                <Text numberOfLines={1} style={ui.muted}>
                  {ENGINES[item.engine].label}
                  {item.host ? ` · ${item.host}` : item.file ? ` · ${item.file}` : ""}
                  {item.safety === "read-only" ? " · read-only" : ""}
                </Text>
                {item.environment === "production" ? <Text style={ui.danger}>Production</Text> : item.environment !== "none" ? <Text style={ui.muted}>{item.environment === "staging" ? "Staging" : "Development"}</Text> : null}
                {item.notEncrypted ? <Text style={ui.warning}>Not encrypted</Text> : null}
              </Pressable>
              <View style={{ paddingRight: 8 }}>
                <Btn icon="Settings2" onPress={() => onEdit(item)} />
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

type Draft = Required<Pick<ConnectionInput, "name" | "engine" | "host" | "user" | "database" | "file" | "serviceName" | "localDataCenter" | "region" | "endpoint" | "accessKeyId" | "authSource" | "caCertificate" | "rememberPassword">> & { port: string; tls: TlsMode; safety: SafetyMode; environment: EnvironmentLabel; color: ConnectionColor | null; group: string; agentAccess: AgentAccess; useSsh: boolean; sshHost: string; sshPort: string; sshUser: string };

export type ConnectionPrefill = Partial<Pick<Draft, "name" | "engine" | "file" | "safety">>;

function emptyDraft(safety: SafetyMode): Draft {
  return { environment: "none", color: null, group: "", agentAccess: "none", name: "", engine: "postgres", host: "localhost", port: "", user: "", database: "", file: "", serviceName: "", localDataCenter: "", region: "", endpoint: "", accessKeyId: "", authSource: "", caCertificate: "", rememberPassword: true, tls: "off", safety, useSsh: false, sshHost: "", sshPort: "22", sshUser: "" };
}

function toDraft(connection: ConnectionView): Draft {
  return { environment: connection.environment, color: connection.color, group: connection.group, agentAccess: connection.agentAccess, name: connection.name, engine: connection.engine, host: connection.host, port: connection.port === null ? "" : String(connection.port), user: connection.user, database: connection.database, file: connection.file, serviceName: connection.serviceName, localDataCenter: connection.localDataCenter, region: connection.region, endpoint: connection.endpoint, accessKeyId: connection.accessKeyId, authSource: connection.authSource, caCertificate: connection.caCertificate, rememberPassword: connection.rememberPassword, tls: connection.tls, safety: connection.safety, useSsh: connection.ssh !== null, sshHost: connection.ssh?.host ?? "", sshPort: String(connection.ssh?.port ?? 22), sshUser: connection.ssh?.user ?? "" };
}

export function ConnectionForm({ connection, prefill, note, onClose, onSaved, onDeleted }: { connection: ConnectionView | null; prefill?: ConnectionPrefill; note?: string; onClose: () => void; onSaved: (saved: ConnectionView) => void; onDeleted: (id: string) => void }) {
  const ui = useUi();
  const api = useApi();
  const ask = useConfirm();
  const preferences = usePreferences();
  // The preference applies only here. A stored connection never takes its write mode from a preference.
  const [draft, setDraft] = useState<Draft>(() => (connection ? toDraft(connection) : { ...emptyDraft(preferences.newConnectionSafety), ...prefill }));
  const [url, setUrl] = useState("");
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
    agentAccess: info.catalogSchema && draft.environment !== "production" ? draft.agentAccess : "none",
    rememberPassword: draft.rememberPassword,
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

  return (
    <Modal title={connection ? `Edit ${connection.name}` : "Add connection"} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        {note ? <Message kind="warning" text={note} /> : null}
        {connection || prefill ? null : <Field label="Paste a connection URL (optional)" value={url} onChangeText={applyUrl} placeholder="postgres://user:password@host:5432/db" secure={url.includes("@")} />}
        <Field label="Name" value={draft.name} onChangeText={(name) => set({ name })} placeholder={info.label} />
        <View style={{ gap: 4 }}>
          <Text style={ui.label}>Database type</Text>
          <View style={ui.wrap}>
            {ENGINE_IDS.map((id: EngineId) => (
              <Chip key={id} label={ENGINES[id].label} on={draft.engine === id} onPress={() => set({ engine: id, port: "" })} />
            ))}
          </View>
          <Text style={ui.muted}>Also works with: {info.alsoWorksWith}</Text>
        </View>
        {has("file") ? <Field label={FIELD_LABELS.file} value={draft.file} onChangeText={(file) => set({ file })} placeholder="/path/to/data.db" mono /> : null}
        {has("host") ? (
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ flex: 3 }}><Field label={FIELD_LABELS.host} value={draft.host} onChangeText={setHost} /></View>
            <View style={{ flex: 1 }}><Field label={FIELD_LABELS.port} value={draft.port} onChangeText={(port) => set({ port: port.replace(/\D/g, "") })} placeholder={String(info.defaultPort ?? "")} /></View>
          </View>
        ) : null}
        {has("region") ? <Field label={FIELD_LABELS.region} value={draft.region} onChangeText={(region) => set({ region })} placeholder="us-east-1" /> : null}
        {has("endpoint") ? <Field label={FIELD_LABELS.endpoint} value={draft.endpoint} onChangeText={(endpoint) => set({ endpoint })} /> : null}
        {has("accessKeyId") ? <Field label={FIELD_LABELS.accessKeyId} value={draft.accessKeyId} onChangeText={(accessKeyId) => set({ accessKeyId })} /> : null}
        {has("serviceName") ? <Field label={FIELD_LABELS.serviceName} value={draft.serviceName} onChangeText={(serviceName) => set({ serviceName })} placeholder="FREEPDB1" /> : null}
        {has("localDataCenter") ? <Field label={FIELD_LABELS.localDataCenter} value={draft.localDataCenter} onChangeText={(localDataCenter) => set({ localDataCenter })} placeholder="datacenter1" /> : null}
        {has("user") ? <Field label={FIELD_LABELS.user} value={draft.user} onChangeText={(user) => set({ user })} /> : null}
        {has("password") ? <Field label={has("accessKeyId") ? "Secret access key" : FIELD_LABELS.password} value={password ?? ""} onChangeText={setPassword} secure hint={secretHint(connection?.hasPassword)} /> : null}
        {has("password") ? (
          <View style={ui.wrap}>
            <Chip label="Remember password" on={draft.rememberPassword} onPress={() => set({ rememberPassword: true })} />
            <Chip label="This session only" on={!draft.rememberPassword} onPress={() => set({ rememberPassword: false })} />
            <Text style={ui.muted}>{draft.rememberPassword ? "Stored in a file only your user can read. Agents you run as this user can read it too." : "Kept in memory, and asked for again after Paseo restarts. SSH secrets and API keys are still stored in the file."}</Text>
          </View>
        ) : null}
        {has("apiKey") ? <Field label={FIELD_LABELS.apiKey} value={apiKey ?? ""} onChangeText={setApiKey} secure hint={secretHint(connection?.hasApiKey)} /> : null}
        {has("database") ? <Field label={FIELD_LABELS.database} value={draft.database} onChangeText={(database) => set({ database })} /> : null}
        {has("authSource") ? <Field label={FIELD_LABELS.authSource} value={draft.authSource} onChangeText={(authSource) => set({ authSource })} placeholder="admin" /> : null}

        <View style={{ gap: 4 }}>
          <Text style={ui.label}>When writing</Text>
          <View style={ui.wrap}>
            <Chip label="Read-only" on={draft.safety === "read-only"} onPress={() => set({ safety: "read-only" })} />
            <Chip label="Ask first" on={draft.safety === "confirm"} onPress={() => set({ safety: "confirm" })} />
            {draft.environment === "production" ? null : <Chip label="No prompts" on={draft.safety === "open"} onPress={() => set({ safety: "open" })} />}
          </View>
          <Text style={ui.muted}>{SAFETY_TEXT[draft.safety]}</Text>
        </View>

        <View style={{ gap: 4 }}>
          <Text style={ui.label}>Environment</Text>
          <View style={ui.wrap}>
            {ENVIRONMENTS.map((item) => (
              <Chip key={item.value} label={item.label} on={draft.environment === item.value} onPress={() => set(item.value === "production" ? { environment: item.value, agentAccess: "none", safety: draft.safety === "open" ? "confirm" : draft.safety } : { environment: item.value })} />
            ))}
          </View>
          <Text style={ui.muted}>{draft.environment === "production" ? "Shows a banner on every tab. No prompts and agent access are not allowed." : "A label you set. Datawise does not guess it from the host name."}</Text>
        </View>
        <View style={{ gap: 4 }}>
          <Text style={ui.label}>Color</Text>
          <View style={ui.wrap}>
            <Chip label="None" on={draft.color === null} onPress={() => set({ color: null })} />
            {COLORS.map((color) => (
              <Pressable key={color} accessibilityRole="button" accessibilityLabel={`Color ${color}`} accessibilityState={{ selected: draft.color === color }} onPress={() => set({ color })} style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: connectionColorValue(ui.colors, color) ?? "transparent", borderWidth: draft.color === color ? 3 : 0, borderColor: ui.colors.foreground }} />
            ))}
          </View>
        </View>
        <Field label="Group" value={draft.group} onChangeText={(group) => set({ group: group.slice(0, 60) })} placeholder="Optional, such as a project name" />

        {info.catalogSchema && draft.environment !== "production" ? (
          <View style={{ gap: 4 }}>
            <Text style={ui.label}>Agents</Text>
            <View style={ui.wrap}>
              <Chip label="No access" on={draft.agentAccess === "none"} onPress={() => set({ agentAccess: "none" })} />
              <Chip label="Table and column names" on={draft.agentAccess === "schema"} onPress={() => set({ agentAccess: "schema" })} />
            </View>
            <Text style={ui.muted}>
              {draft.agentAccess === "schema" ? "Every agent can read this connection's table names, column names and types. Never its rows. Names can hold text someone else wrote. Turning this on or off makes open agent sessions reopen before their next prompt. Agents only get this while Paseo's \"Enable Paseo tools\" host setting is on." : "Agents cannot see this connection through Datawise."}
            </Text>
          </View>
        ) : null}

        {info.supportsTls ? (
          <View style={{ gap: 4 }}>
            <Text style={ui.label}>Encryption</Text>
            <View style={ui.wrap}>
              {(["off", "require", "verify"] as const).map((mode) => (
                <Chip
                  key={mode}
                  label={mode === "off" ? "Off" : mode === "require" ? "Required" : "Verified"}
                  on={draft.tls === mode}
                  onPress={() => {
                    setTlsTouched(true);
                    set({ tls: mode });
                  }}
                />
              ))}
            </View>
            <Text style={ui.muted}>{TLS_TEXT[draft.tls]}</Text>
            {draft.tls === "verify" ? <Field label="CA certificate (optional, PEM text)" value={draft.caCertificate} onChangeText={(caCertificate) => set({ caCertificate })} multiline mono /> : null}
          </View>
        ) : null}

        {info.supportsSsh ? (
          <View style={{ gap: 6 }}>
            <View style={ui.wrap}>
              <Chip label="Direct" on={!draft.useSsh} onPress={() => set({ useSsh: false })} />
              <Chip label="Through SSH" on={draft.useSsh} onPress={() => set({ useSsh: true })} />
            </View>
            {draft.useSsh ? (
              <>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <View style={{ flex: 3 }}><Field label="SSH host" value={draft.sshHost} onChangeText={(sshHost) => set({ sshHost })} /></View>
                  <View style={{ flex: 1 }}><Field label="Port" value={draft.sshPort} onChangeText={(sshPort) => set({ sshPort: sshPort.replace(/\D/g, "") })} /></View>
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

        {result ? <Message kind={result.kind} text={result.text} /> : null}
        <View style={[ui.row, { justifyContent: "space-between", flexWrap: "wrap" }]}>
          {connection ? <Btn label="Delete" kind="danger" disabled={busy} onPress={() => void remove()} /> : <View />}
          <View style={ui.row}>
            <Btn label={busy ? "Working…" : "Test"} disabled={busy} onPress={() => void test()} />
            <Btn label="Save" kind="primary" disabled={busy} onPress={() => void save()} />
          </View>
        </View>
      </Modal.Content>
    </Modal>
  );
}
