import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { FlatList, Icon, Modal as HostModal, type ModalContentProps, type ModalProps, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
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
    toolbar: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 4, paddingHorizontal: 8, paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: c.border },
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

// An icon-only button must say what it does, because a screen reader has nothing else to read.
type BtnName = { label: string; title?: string } | { label?: undefined; title: string };

// Only "primary" is filled with the accent color, so the accent always means the main action of a view.
export function Btn({ label, title, icon, onPress, kind = "ghost", disabled = false, on = false }: BtnName & { icon?: string; onPress: () => void; kind?: "primary" | "ghost" | "danger"; disabled?: boolean; on?: boolean }) {
  const ui = useUi();
  const c = ui.colors;
  const [hovered, setHovered] = useState(false);
  const fg = kind === "primary" ? c.accentForeground : kind === "danger" ? c.statusDanger : label || on ? c.foreground : c.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title ?? label}
      accessibilityState={{ disabled, selected: on }}
      aria-selected={on}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        minHeight: ui.compact ? 36 : 30,
        minWidth: ui.compact ? 36 : 30,
        paddingHorizontal: label ? 10 : 6,
        borderRadius: 6,
        backgroundColor: kind === "primary" ? c.accent : on || pressed || (hovered && !disabled) ? c.surface2 : "transparent",
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
      aria-selected={on}
      disabled={disabled}
      onPress={onPress}
      style={{ minHeight: ui.compact ? 32 : 24, justifyContent: "center", paddingHorizontal: 9, borderRadius: 6, borderWidth: 1, borderColor: on ? c.surface2 : c.border, backgroundColor: on ? c.surface2 : "transparent", opacity: disabled ? 0.45 : 1 }}
    >
      <Text style={{ fontSize: 12, color: on ? c.foreground : c.foregroundMuted, fontWeight: on ? "500" : "400" }}>{label}</Text>
    </Pressable>
  );
}

// One choice out of a few, shown together. Choices with a consequence stay visible this way.
export function Segmented<Value extends string>({ label, value, options, onChange }: { label: string; value: Value; options: { label: string; value: Value }[]; onChange: (value: Value) => void }) {
  const ui = useUi();
  const c = ui.colors;
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: "row", flexWrap: "wrap", alignSelf: "flex-start", maxWidth: "100%", padding: 2, gap: 2, borderRadius: 7, backgroundColor: c.surface2 }}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable key={option.value} accessibilityRole="radio" accessibilityLabel={option.label} accessibilityState={{ checked: on }} aria-checked={on} onPress={() => onChange(option.value)} style={{ minHeight: ui.compact ? 32 : 24, justifyContent: "center", paddingHorizontal: 9, borderRadius: 5, backgroundColor: on ? c.surface0 : "transparent" }}>
            <Text style={{ fontSize: 12, color: on ? c.foreground : c.foregroundMuted, fontWeight: on ? "500" : "400" }}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// A group of settings that opens on press. Its value shows while closed, so nothing is hidden silently.
export function Section({ title, value, warn = false, children }: { title: string; value: string; warn?: boolean; children: ReactNode }) {
  const ui = useUi();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: ui.colors.border }}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${title}: ${value}`} accessibilityState={{ expanded: open }} aria-expanded={open} onPress={() => setOpen((current) => !current)} style={[ui.row, { minHeight: 40 }]}>
        <Text style={[ui.body, { fontWeight: "500" }]}>{title}</Text>
        <Text numberOfLines={1} style={[warn ? ui.warning : ui.muted, { flex: 1, textAlign: "right" }]}>
          {value}
        </Text>
        <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} color={ui.colors.foregroundMuted} />
      </Pressable>
      {open ? <View style={{ gap: 12, paddingBottom: 14 }}>{children}</View> : null}
    </View>
  );
}

// A small status label. `detail` is what a screen reader hears, when the short text leaves something out.
export function Pill({ text, kind = "neutral", detail }: { text: string; kind?: "neutral" | "warning" | "danger"; detail?: string }) {
  const ui = useUi();
  const c = ui.colors;
  const color = kind === "danger" ? c.statusDanger : kind === "warning" ? c.statusWarning : c.foregroundMuted;
  return (
    <View accessible accessibilityLabel={detail ?? text} style={{ flexShrink: 0, maxWidth: "100%", paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, borderWidth: 1, borderColor: color }}>
      <Text numberOfLines={1} style={{ fontSize: 11, color, fontWeight: kind === "danger" ? "600" : "500" }}>
        {text}
      </Text>
    </View>
  );
}

// Rarely used actions, one press further away.
export interface MenuItem {
  label: string;
  icon: string;
  detail?: string;
  disabled?: boolean;
  onPress: () => void;
}

export function MoreMenu({ title = "More actions", items }: { title?: string; items: MenuItem[] }) {
  const ui = useUi();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Btn icon="Ellipsis" title={title} onPress={() => setOpen(true)} />
      <Modal title={title} open={open} onOpenChange={setOpen}>
        <Modal.Content contentContainerStyle={{ padding: 8, gap: 0 }}>
          {items.map((item) => (
            <Pressable
              key={item.label}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              accessibilityState={{ disabled: item.disabled === true }}
              disabled={item.disabled}
              onPress={() => {
                setOpen(false);
                item.onPress();
              }}
              style={({ pressed }) => [ui.row, { gap: 10, padding: 10, borderRadius: 6, backgroundColor: pressed ? ui.colors.surface2 : "transparent", opacity: item.disabled ? 0.45 : 1 }]}
            >
              <Icon name={item.icon} size={15} color={ui.colors.foregroundMuted} />
              <View style={{ flex: 1, gap: 1 }}>
                <Text style={ui.body}>{item.label}</Text>
                {item.detail ? <Text style={ui.muted}>{item.detail}</Text> : null}
              </View>
            </Pressable>
          ))}
        </Modal.Content>
      </Modal>
    </>
  );
}

// A dialog body that scrolls while its footer stays in view. Use inside Modal.Content with scrollable={false}.
export function PinnedFooter({ footer, children }: { footer: ReactNode; children: ReactNode }) {
  const ui = useUi();
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <ScrollView style={{ flex: 1, minHeight: 0 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 12 }}>
        {children}
      </ScrollView>
      <View style={{ paddingHorizontal: 16, paddingVertical: 10, gap: 8, borderTopWidth: 1, borderTopColor: ui.colors.border }}>
        {footer}
      </View>
    </View>
  );
}

export function Field({ label, labelAction, hint, value, onChangeText, placeholder, secure = false, multiline = false, mono = false, editable = true }: { label: string; labelAction?: ReactNode; hint?: string; value: string; onChangeText: (text: string) => void; placeholder?: string; secure?: boolean; multiline?: boolean; mono?: boolean; editable?: boolean }) {
  const ui = useUi();
  return (
    <View style={{ gap: 4 }}>
      <View style={[ui.row, { justifyContent: "space-between" }]}>
        <Text style={[ui.label, { flexShrink: 1 }]}>{label}</Text>
        {labelAction}
      </View>
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

// Above this many, a list is drawn lazily, and the host then gives the dialog a fixed height.
const LONG_LIST = 40;

// A press-to-open list that works the same on phone and desktop. There is no shared native picker.
export function Select({ label, value, options, onChange, placeholder = "Choose" }: { label: string; value: string; options: { label: string; value: string; detail?: string }[]; onChange: (value: string) => void; placeholder?: string }) {
  const ui = useUi();
  const [open, setOpen] = useState(false);
  const shown = options.find((option) => option.value === value)?.label ?? placeholder;
  const renderOption = (item: (typeof options)[number]) => (
    <Pressable
      key={item.value}
      accessibilityRole="button"
      accessibilityState={{ selected: item.value === value }}
      onPress={() => {
        // Choosing the current value is not a change, and a handler may reset other fields on a change.
        if (item.value !== value) onChange(item.value);
        setOpen(false);
      }}
      style={({ pressed }) => ({ paddingHorizontal: 14, paddingVertical: 10, gap: 1, backgroundColor: item.value === value || pressed ? ui.colors.surface2 : "transparent" })}
    >
      <Text style={ui.body}>{item.label}</Text>
      {item.detail ? <Text style={ui.muted}>{item.detail}</Text> : null}
    </Pressable>
  );
  const long = options.length > LONG_LIST;
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${shown}`} onPress={() => setOpen(true)} style={[ui.input, { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 6, minWidth: 0 }]}>
        <Text numberOfLines={1} style={[ui.body, { flexShrink: 1 }]}>
          {shown}
        </Text>
        <Icon name="ChevronDown" size={13} color={ui.colors.foregroundMuted} />
      </Pressable>
      <Modal title={label} open={open} onOpenChange={setOpen}>
        <Modal.Content scrollable={!long} contentContainerStyle={{ padding: 0, gap: 0 }}>
          {long ? <FlatList style={{ flex: 1, minHeight: 0 }} data={options} keyExtractor={(option) => option.value} renderItem={({ item }) => renderOption(item)} /> : options.map(renderOption)}
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
