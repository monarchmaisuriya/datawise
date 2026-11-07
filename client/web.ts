import type { EditorView, EditorViewConfig } from "@codemirror/view";
import { Platform } from "react-native";
import type { EngineId } from "../shared/engines";
import type { Theme } from "./kit";

export const COMPLETION_ENGINES: readonly EngineId[] = ["postgres", "mysql", "sqlite", "mssql", "oracle", "clickhouse", "cassandra"];

export interface SqlEditorHandle {
  // Replaces the text without reporting an edit, and clears the selection, so old offsets cannot survive.
  setText(text: string): void;
  clearSelection(): void;
  // The selected text, or the whole text when nothing is selected, read from the editor at this moment.
  toRun(): string;
  setSchema(schema: Record<string, string[]>): void;
  destroy(): void;
}

export interface SqlEditorOptions {
  text: string;
  theme: Theme;
  engine: EngineId;
  label: string;
  readOnly: boolean;
  fontSize: number;
  onChange: (text: string) => void;
  onSelection: (selected: string) => void;
  onRun: () => void;
}

// DOM code stays here. Native never evaluates the editor packages.
export function mountSqlEditor(parent: unknown, options: SqlEditorOptions): SqlEditorHandle | null {
  if (Platform.OS !== "web" || !parent) return null;
  const { Compartment, EditorState, Prec } = require("@codemirror/state") as typeof import("@codemirror/state");
  const { drawSelection, EditorView: View, keymap, lineNumbers, placeholder } = require("@codemirror/view") as typeof import("@codemirror/view");
  const { defaultKeymap, history, historyKeymap } = require("@codemirror/commands") as typeof import("@codemirror/commands");
  const { HighlightStyle, syntaxHighlighting } = require("@codemirror/language") as typeof import("@codemirror/language");
  const { autocompletion, completionKeymap } = require("@codemirror/autocomplete") as typeof import("@codemirror/autocomplete");
  const lang = require("@codemirror/lang-sql") as typeof import("@codemirror/lang-sql");
  const { tags } = require("@lezer/highlight") as typeof import("@lezer/highlight");
  const dialects: Partial<Record<EngineId, import("@codemirror/lang-sql").SQLDialect>> = { postgres: lang.PostgreSQL, mysql: lang.MySQL, sqlite: lang.SQLite, mssql: lang.MSSQL, oracle: lang.PLSQL, clickhouse: lang.StandardSQL, cassandra: lang.Cassandra };
  const dialect = dialects[options.engine];
  const c = options.theme.colors;
  const language = new Compartment();
  const languageFor = (schema: Record<string, string[]>) => (dialect ? lang.sql({ dialect, schema }) : []);
  let applying = false;
  const view: EditorView = new View({
    parent: parent as EditorViewConfig["parent"],
    state: EditorState.create({
      doc: options.text,
      extensions: [
        language.of(languageFor({})),
        syntaxHighlighting(
          HighlightStyle.define([
            // Not the accent color: that is a button fill and can be too dark to read as text.
            { tag: tags.keyword, color: c.foreground, fontWeight: "600" },
            { tag: [tags.string, tags.special(tags.string)], color: c.statusSuccess },
            { tag: [tags.number, tags.bool, tags.null], color: c.statusWarning },
            { tag: [tags.lineComment, tags.blockComment], color: c.foregroundMuted, fontStyle: "italic" },
          ]),
        ),
        lineNumbers(),
        // Keeps the selection visible when focus moves to the Run button.
        drawSelection(),
        history(),
        autocompletion(),
        Prec.highest(
          keymap.of([
            {
              key: "Mod-Enter",
              run() {
                options.onRun();
                return true;
              },
            },
          ]),
        ),
        keymap.of([...completionKeymap, ...defaultKeymap, ...historyKeymap]),
        View.lineWrapping,
        EditorState.readOnly.of(options.readOnly),
        placeholder(options.label),
        View.contentAttributes.of({ "aria-label": options.label, autocapitalize: "off", autocorrect: "off", spellcheck: "false" }),
        View.theme({
          "&": { height: "100%", color: c.foreground, backgroundColor: c.surface1, fontSize: `${options.fontSize}px` },
          "&.cm-focused": { outline: "none" },
          ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, Menlo, Consolas, monospace" },
          ".cm-content": { caretColor: c.foreground },
          ".cm-cursor": { borderLeftColor: c.foreground },
          ".cm-gutters": { backgroundColor: c.surface1, color: c.foregroundMuted, border: "none" },
          ".cm-activeLineGutter, .cm-activeLine": { backgroundColor: "transparent" },
          // As specific as CodeMirror's own rule, whose fixed color can hide the text.
          "& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": { backgroundColor: `color-mix(in srgb, ${c.accent} 45%, transparent)` },
          ".cm-tooltip": { backgroundColor: c.surface1, color: c.foreground, borderColor: c.border },
          ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: c.accent, color: c.accentForeground },
        }),
        View.updateListener.of((update) => {
          if (update.docChanged && !applying) options.onChange(update.state.doc.toString());
          // Read from the document as it is now, so this can never describe an older text.
          if (update.docChanged || update.selectionSet) {
            const { from, to } = update.state.selection.main;
            options.onSelection(update.state.sliceDoc(from, to));
          }
        }),
      ],
    }),
  });
  return {
    setText(next) {
      if (view.state.doc.toString() === next) return;
      applying = true;
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next }, selection: { anchor: 0 } });
      } finally {
        applying = false;
      }
    },
    clearSelection() {
      view.dispatch({ selection: { anchor: 0 } });
    },
    toRun() {
      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);
      return selected.trim() === "" ? view.state.doc.toString() : selected;
    },
    setSchema(schema) {
      view.dispatch({ effects: language.reconfigure(languageFor(schema)) });
    },
    destroy() {
      view.destroy();
    },
  };
}
