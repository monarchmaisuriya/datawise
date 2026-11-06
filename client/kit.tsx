import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { FlatList, Icon, Modal as HostModal, type ModalContentProps, type ModalProps, TextInput } from "@getpaseo/plugin/client/ui";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { PendingContext } from "./pending";
import { PreferencesContext } from "./preferences";
import { BYTES_TAG, type ConnectionColor, type JobView, rpc, type StartResult } from "../shared/contracts";

export type Theme = PluginSurfaceProps["theme"];
export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, Menlo, Consolas, monospace" });

function buildStyles(theme: Theme, compact: boolean) {
  const c = theme.colors;
  return {
    compact,
    theme,
    colors: c,
    root: { flex: 1, minHeight: 0, backgroundColor: c.surface0 },
    title: { color: c.foreground, fontSize: 15, fontWeight: "600" as const },
    body: { color: c.foreground, fontSize: 13 },
    mono: { color: c.foreground, fontSize: 12, fontFamily: MONO },
    muted: { color: c.foregroundMuted, fontSize: 12 },
    label: { color: c.foregroundMuted, fontSize: 12, fontWeight: "500" as const },
    danger: { color: c.statusDanger, fontSize: 12 },
    warning: { color: c.statusWarning, fontSize: 12 },
    success: { color: c.statusSuccess, fontSize: 12 },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    wrap: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 6 },
    input: { borderWidth: 1, borderColor: c.border, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 7, fontSize: 13, color: c.foreground, backgroundColor: c.surface1 },
    card: { borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.surface1, padding: 12, gap: 8 },
    divider: { height: 1, backgroundColor: c.border },
    toolbar: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 6, padding: 8, borderBottomWidth: 1, borderBottomColor: c.border },
  };
}
export type Styles = ReturnType<typeof buildStyles>;

const UiContext = createContext<Styles | null>(null);

export function useUi(): Styles {
  const value = useContext(UiContext);
  if (!value) throw new Error("Datawise UI used outside its provider");
  return value;
}

export function UiProvider({ theme, compact, children }: { theme: Theme; compact: boolean; children: ReactNode }) {
  const styles = useMemo(() => buildStyles(theme, compact), [theme, compact]);
  return <UiContext.Provider value={styles}>{children}</UiContext.Provider>;
}

// Every RPC in one object, so a screen does not repeat a hook per call.
export function useApi() {
  const api = {
    listConnections: useRpc(rpc.listConnections),
    saveConnection: useRpc(rpc.saveConnection),
    deleteConnection: useRpc(rpc.deleteConnection),
    testConnection: useRpc(rpc.testConnection),
    disconnect: useRpc(rpc.disconnect),
    unlockConnection: useRpc(rpc.unlockConnection),
    clearSshFingerprint: useRpc(rpc.clearSshFingerprint),
    listDatabases: useRpc(rpc.listDatabases),
    listSchemas: useRpc(rpc.listSchemas),
    listObjects: useRpc(rpc.listObjects),
    describeObject: useRpc(rpc.describeObject),
    readRows: useRpc(rpc.readRows),
    countRows: useRpc(rpc.countRows),
    readRow: useRpc(rpc.readRow),
    writeRows: useRpc(rpc.writeRows),
    writeBatch: useRpc(rpc.writeBatch),
    destroyObject: useRpc(rpc.destroyObject),
    runQuery: useRpc(rpc.runQuery),
    listHistory: useRpc(rpc.listHistory),
    clearHistory: useRpc(rpc.clearHistory),
    listSaved: useRpc(rpc.listSaved),
    saveQuery: useRpc(rpc.saveQuery),
    deleteSaved: useRpc(rpc.deleteSaved),
    importPreview: useRpc(rpc.importPreview),
    startImport: useRpc(rpc.startImport),
    startExport: useRpc(rpc.startExport),
    defaultExportPath: useRpc(rpc.defaultExportPath),
    exportText: useRpc(rpc.exportText),
    jobStatus: useRpc(rpc.jobStatus),
    cancelJob: useRpc(rpc.cancelJob),
    getView: useRpc(rpc.getView),
    saveView: useRpc(rpc.saveView),
    getPlace: useRpc(rpc.getPlace),
    savePlace: useRpc(rpc.savePlace),
    getQueryTabs: useRpc(rpc.getQueryTabs),
    saveQueryTabs: useRpc(rpc.saveQueryTabs),
    inspectSqlite: useRpc(rpc.inspectSqlite),
    listAgentRequests: useRpc(rpc.listAgentRequests),
    getAgentRequest: useRpc(rpc.getAgentRequest),
    decideAgentRequest: useRpc(rpc.decideAgentRequest),
    listAgentActivity: useRpc(rpc.listAgentActivity),
    clearAgentActivity: useRpc(rpc.clearAgentActivity),
  };
  const latest = useRef(api);
  latest.current = api;
  return latest.current;
}
export type Api = ReturnType<typeof useApi>;

// Polls until the job ends. The daemon limits a single RPC to 30 seconds, so long work is never awaited
// directly. A lost poll is retried a few times, because a reconnect must not look like a failed write.
export async function waitForJob(api: Api, job: JobView, onUpdate?: (job: JobView) => void): Promise<JobView> {
  let current = job;
  let missed = 0;
  let delay = 150;
  while (current.status === "running") {
    await new Promise<void>((resolve) => setTimeout(() => resolve(), delay));
    delay = Math.min(delay * 1.5, 1000);
    try {
      current = await api.jobStatus({ id: job.id });
      missed = 0;
      onUpdate?.(current);
    } catch (error) {
      missed += 1;
      if (missed > 5) throw error;
    }
  }
  return current;
}

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // The host wraps a plugin's error with transport details that mean nothing to the person reading it.
  return message.replace(/^Request failed:\s*/, "").replace(/\s*requestType=\S+(?:\s+code=\S+)?\s*$/, "");
}

export function isBytes(cell: unknown): boolean {
  return cell !== null && typeof cell === "object" && BYTES_TAG in cell;
}

export function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "string") return cell;
  if (typeof cell === "object") {
    if (isBytes(cell)) return `<${Math.floor((String(Reflect.get(cell, BYTES_TAG)).length * 3) / 4)} bytes>`;
    return JSON.stringify(cell);
  }
  return String(cell);
}

// The palette is theme tokens, so a label stays readable in every theme.
export function connectionColorValue(colors: Theme["colors"], color: ConnectionColor | null): string | null {
  if (!color) return null;
  return { red: colors.statusDanger, amber: colors.statusWarning, green: colors.statusSuccess, gray: colors.foregroundMuted, contrast: colors.foreground }[color];
}

export function Btn({ label, icon, onPress, kind = "ghost", disabled = false }: { label?: string; icon?: string; onPress: () => void; kind?: "primary" | "ghost" | "danger"; disabled?: boolean }) {
  const ui = useUi();
  const c = ui.colors;
  const fg = kind === "primary" ? c.accentForeground : kind === "danger" ? c.statusDanger : c.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? icon}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        minHeight: ui.compact ? 36 : 30,
        paddingHorizontal: label ? 10 : 7,
        borderRadius: 6,
        borderWidth: kind === "primary" ? 0 : 1,
        borderColor: kind === "danger" ? c.statusDanger : c.border,
        backgroundColor: kind === "primary" ? c.accent : pressed ? c.surface2 : "transparent",
        opacity: disabled ? 0.45 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={14} color={fg} /> : null}
      {label ? <Text style={{ color: fg, fontSize: 12, fontWeight: "500" }}>{label}</Text> : null}
    </Pressable>
  );
}

export function Chip({ label, on, onPress, disabled = false }: { label: string; on: boolean; onPress: () => void; disabled?: boolean }) {
  const ui = useUi();
  const c = ui.colors;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ minHeight: ui.compact ? 32 : 26, justifyContent: "center", paddingHorizontal: 10, borderRadius: 999, borderWidth: 1, borderColor: on ? c.accent : c.border, backgroundColor: on ? c.accent : "transparent", opacity: disabled ? 0.45 : 1 }}
    >
      <Text style={{ fontSize: 12, color: on ? c.accentForeground : c.foregroundMuted }}>{label}</Text>
    </Pressable>
  );
}

export function Field({ label, hint, value, onChangeText, placeholder, secure = false, multiline = false, mono = false, editable = true }: { label: string; hint?: string; value: string; onChangeText: (text: string) => void; placeholder?: string; secure?: boolean; multiline?: boolean; mono?: boolean; editable?: boolean }) {
  const ui = useUi();
  return (
    <View style={{ gap: 4 }}>
      <Text style={ui.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={ui.colors.foregroundMuted}
        secureTextEntry={secure}
        multiline={multiline}
        editable={editable}
        autoCapitalize="none"
        autoCorrect={false}
        style={[ui.input, multiline ? { minHeight: 72, textAlignVertical: "top" } : null, mono ? { fontFamily: MONO } : null, editable ? null : { opacity: 0.6 }]}
      />
      {hint ? <Text style={ui.muted}>{hint}</Text> : null}
    </View>
  );
}

export function Message({ kind, text }: { kind: "error" | "warning" | "success" | "note"; text: string }) {
  const ui = useUi();
  const style = kind === "error" ? ui.danger : kind === "warning" ? ui.warning : kind === "success" ? ui.success : ui.muted;
  return (
    <Text selectable style={[style, { paddingVertical: 2 }]}>
      {text}
    </Text>
  );
}

// A press-to-open list that works the same on phone and desktop. There is no shared native picker.
export function Select({ label, value, options, onChange, placeholder = "Choose" }: { label: string; value: string; options: { label: string; value: string }[]; onChange: (value: string) => void; placeholder?: string }) {
  const ui = useUi();
  const [open, setOpen] = useState(false);
  const shown = options.find((option) => option.value === value)?.label ?? placeholder;
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${shown}`} onPress={() => setOpen(true)} style={[ui.input, { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 6, minWidth: 90 }]}>
        <Text numberOfLines={1} style={[ui.body, { flexShrink: 1 }]}>
          {shown}
        </Text>
        <Icon name="ChevronDown" size={13} color={ui.colors.foregroundMuted} />
      </Pressable>
      <Modal title={label} open={open} onOpenChange={setOpen}>
        <Modal.Content scrollable={false} contentContainerStyle={{ padding: 0, gap: 0 }}>
          <FlatList
            style={{ flex: 1, minHeight: 0 }}
            data={options}
            keyExtractor={(option) => option.value}
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  onChange(item.value);
                  setOpen(false);
                }}
                style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: ui.colors.border, backgroundColor: item.value === value ? ui.colors.surface2 : "transparent" }}
              >
                <Text style={ui.body}>{item.label}</Text>
              </Pressable>
            )}
          />
        </Modal.Content>
      </Modal>
    </>
  );
}

// The only dialog to use here. At phone width the host draws Modal.Content in a separate layer and restores only
// its own contexts, so anything of ours used inside would throw and take the whole app down.
function BridgedContent({ children, ...props }: ModalContentProps) {
  const ui = useContext(UiContext);
  const confirm = useContext(ConfirmContext);
  const preferences = useContext(PreferencesContext);
  const pending = useContext(PendingContext);
  return (
    <HostModal.Content {...props}>
      <UiContext.Provider value={ui}>
        <ConfirmContext.Provider value={confirm}>
          <PreferencesContext.Provider value={preferences}>
            <PendingContext.Provider value={pending}>{children}</PendingContext.Provider>
          </PreferencesContext.Provider>
        </ConfirmContext.Provider>
      </UiContext.Provider>
    </HostModal.Content>
  );
}

export const Modal = Object.assign((props: ModalProps) => <HostModal {...props} />, { Content: BridgedContent });

interface ConfirmRequest {
  title: string;
  preview: string;
  reason?: string;
  actionLabel: string;
  resolve: (ok: boolean) => void;
}

const ConfirmContext = createContext<((request: Omit<ConfirmRequest, "resolve">) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const ui = useUi();
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const ask = useCallback((next: Omit<ConfirmRequest, "resolve">) => new Promise<boolean>((resolve) => setRequest({ ...next, resolve })), []);
  const answer = (ok: boolean) => {
    request?.resolve(ok);
    setRequest(null);
  };
  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      <Modal title={request?.title ?? "Confirm"} icon={<Icon name="TriangleAlert" size={16} color={ui.colors.statusWarning} />} open={request !== null} onOpenChange={(open) => (open ? undefined : answer(false))}>
        <Modal.Content>
          {request?.reason ? <Text style={ui.body}>{request.reason}</Text> : null}
          <View style={ui.card}>
            <Text selectable style={ui.mono}>
              {request?.preview}
            </Text>
          </View>
          <View style={[ui.row, { justifyContent: "flex-end" }]}>
            <Btn label="Cancel" onPress={() => answer(false)} />
            <Btn label={request?.actionLabel ?? "Run"} kind="primary" onPress={() => answer(true)} />
          </View>
        </Modal.Content>
      </Modal>
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ask = useContext(ConfirmContext);
  if (!ask) throw new Error("Datawise confirm used outside its provider");
  return ask;
}

// Runs an action that may ask first. Returns the finished job, or null if the user said no.
export function useGuardedRun() {
  const ask = useConfirm();
  return useCallback(
    async (api: Api, start: (confirmed: boolean) => Promise<StartResult>, onUpdate?: (job: JobView) => void, onStart?: (job: JobView) => void): Promise<JobView | null> => {
      let result = await start(false);
      if (result.status === "confirm") {
        const ok = await ask({ title: "Run this?", preview: result.preview, reason: result.reason, actionLabel: "Run" });
        if (!ok) return null;
        result = await start(true);
      }
      if (result.status !== "started") return null;
      onStart?.(result.job);
      return waitForJob(api, result.job, onUpdate);
    },
    [ask],
  );
}
