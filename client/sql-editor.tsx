import { TextInput } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { type RefObject, useEffect, useRef } from "react";
import { Platform, View } from "react-native";
import type { ConnectionView, Scope } from "../shared/contracts";
import { ENGINES } from "../shared/engines";
import { type Api, MONO, useApi, useUi } from "./kit";
import { COMPLETION_ENGINES, mountSqlEditor, type SqlEditorHandle } from "./web";

const DESCRIBE_LIMIT = 10;

// Only tables named in the text are described, so typing cannot read the whole catalog.
function useCompletionSchema(api: Api, connection: ConnectionView, scope: Scope, text: string, enabled: boolean): Record<string, string[]> | null {
  const objects = useQuery({ queryKey: ["datawise", "completion", scope], queryFn: () => api.listObjects({ ...scope, pattern: "", cursor: null }), enabled, retry: false, staleTime: 60000 });
  const names = (objects.data?.objects ?? []).map((item) => item.name);
  const known = useRef(new Map<string, string[]>());
  const namedKey = enabled ? names.filter((name) => new RegExp(`\\b${name.replace(/[^\w]/g, "\\$&")}\\b`, "i").test(text)).slice(0, DESCRIBE_LIMIT).join("\n") : "";
  const columns = useQuery({
    queryKey: ["datawise", "completion-columns", scope, namedKey],
    queryFn: async () => {
      for (const name of namedKey.split("\n").filter(Boolean)) {
        if (known.current.has(name)) continue;
        const details = await api.describeObject({ ...scope, name }).catch(() => null);
        if (details) known.current.set(name, details.columns.map((column) => column.name));
      }
      return Object.fromEntries(known.current);
    },
    enabled: namedKey !== "",
    retry: false,
    staleTime: 60000,
  });
  if (!enabled || !objects.data) return null;
  return Object.fromEntries(names.map((name) => [name, columns.data?.[name] ?? []]));
}

// The editor owns the selection, so what runs is read from it at that moment and cannot lag behind it.
export interface EditorControl {
  toRun(): string;
  clearSelection(): void;
}

export function SqlEditor({ control, connection, scope, text, onChangeText, onSelection, onRun, readOnly = false, active = true }: { control: RefObject<EditorControl | null>; connection: ConnectionView; scope: Scope; text: string; onChangeText: (text: string) => void; onSelection: (selected: string) => void; onRun: () => void; readOnly?: boolean; active?: boolean }) {
  const ui = useUi();
  const api = useApi();
  const info = ENGINES[connection.engine];
  const web = Platform.OS === "web";
  const parent = useRef<View>(null);
  const editor = useRef<SqlEditorHandle | null>(null);
  const textNow = useRef(text);
  const nativeSelected = useRef("");
  const latest = useRef({ onChangeText, onSelection, onRun });
  latest.current = { onChangeText, onSelection, onRun };
  const schema = useCompletionSchema(api, connection, scope, text, web && active && !readOnly && COMPLETION_ENGINES.includes(connection.engine));
  const schemaKey = schema ? JSON.stringify(schema) : "";

  useEffect(() => {
    if (!web) return;
    editor.current = mountSqlEditor(parent.current, {
      text: textNow.current,
      theme: ui.theme,
      engine: connection.engine,
      label: info.queryPlaceholder,
      readOnly,
      onChange(next) {
        textNow.current = next;
        latest.current.onChangeText(next);
      },
      onSelection: (selected) => latest.current.onSelection(selected),
      onRun: () => latest.current.onRun(),
    });
    // A new editor has no selection, whatever the last one had.
    latest.current.onSelection("");
    return () => {
      editor.current?.destroy();
      editor.current = null;
    };
    // The editor keeps its own text and undo history, so only these rebuild it.
  }, [web, ui.theme, connection.engine, info.queryPlaceholder, readOnly]);

  useEffect(() => {
    if (text !== textNow.current) {
      textNow.current = text;
      nativeSelected.current = "";
      editor.current?.setText(text);
      latest.current.onSelection("");
    }
  }, [text]);

  useEffect(() => {
    control.current = {
      toRun() {
        if (editor.current) return editor.current.toRun();
        return nativeSelected.current.trim() === "" ? textNow.current : nativeSelected.current;
      },
      clearSelection() {
        nativeSelected.current = "";
        editor.current?.clearSelection();
        latest.current.onSelection("");
      },
    };
  }, [control]);

  useEffect(() => {
    if (schema) editor.current?.setSchema(schema);
    // The serialized form, so a new object with the same contents does not rebuild the language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaKey]);

  const height = ui.compact ? 120 : 160;
  if (web) return <View ref={parent} style={{ height, borderWidth: 1, borderColor: ui.colors.border, borderRadius: 6, overflow: "hidden" }} />;
  return (
    <TextInput
      accessibilityLabel={`${info.queryLanguage} to run`}
      value={text}
      editable={!readOnly}
      onChangeText={(next) => {
        textNow.current = next;
        nativeSelected.current = "";
        onSelection("");
        onChangeText(next);
      }}
      onSelectionChange={({ nativeEvent: { selection } }) => {
        nativeSelected.current = textNow.current.slice(selection.start, selection.end);
        onSelection(nativeSelected.current);
      }}
      placeholder={info.queryPlaceholder}
      placeholderTextColor={ui.colors.foregroundMuted}
      multiline
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      style={[ui.input, { fontFamily: MONO, fontSize: 12, height, textAlignVertical: "top" }]}
    />
  );
}
