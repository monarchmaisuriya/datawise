import { copyText, Modal, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ConnectionView, ExportFormat, ExportSource, ImportFormat, JobView, ObjectRef } from "../shared/contracts";
import { ENGINES } from "../shared/engines";
import { Btn, cellText, Chip, errorText, Field, Message, Select, useApi, useGuardedRun, useUi, waitForJob } from "./kit";

const EXPORT_FORMATS: { value: ExportFormat; label: string }[] = [
  { value: "csv", label: "CSV" },
  { value: "tsv", label: "TSV" },
  { value: "json", label: "JSON" },
  { value: "ndjson", label: "NDJSON" },
  { value: "sql", label: "SQL inserts" },
];

export function ExportModal({ connection, source, name, onClose }: { connection: ConnectionView; source: ExportSource; name: string; onClose: () => void }) {
  const ui = useUi();
  const api = useApi();
  const toast = useToast();
  const info = ENGINES[connection.engine];
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [path, setPath] = useState("");
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const formats = EXPORT_FORMATS.filter((item) => item.value !== "sql" || info.exportSqlInserts);
  const running = job?.status === "running";

  useEffect(() => {
    let live = true;
    void api.defaultExportPath({ name, format }).then((answer) => {
      if (live) setPath(answer.path);
    });
    return () => {
      live = false;
    };
    // The api object is stable; only name and format change the suggestion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, format]);

  const run = async (start: () => Promise<JobView>, after?: (done: JobView) => Promise<void>) => {
    setError(null);
    try {
      const started = await start();
      setJob(started);
      const done = await waitForJob(api, started, setJob);
      setJob(done);
      if (done.status === "done") await after?.(done);
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  return (
    <Modal title="Export" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <View style={{ gap: 4 }}>
          <Text style={ui.label}>Format</Text>
          <View style={ui.wrap}>
            {formats.map((item) => (
              <Chip key={item.value} label={item.label} on={format === item.value} onPress={() => setFormat(item.value)} />
            ))}
          </View>
        </View>
        <Field label="File on the daemon machine" value={path} onChangeText={setPath} mono hint="An existing file is never replaced." />
        {job ? (
          <View style={{ gap: 4 }}>
            {job.status === "running" ? <Message kind="note" text={`${job.rows} rows so far…`} /> : null}
            {job.status === "done" ? <Message kind="success" text={`${job.message ?? "Done."}${job.path ? `\n${job.path}` : ""}`} /> : null}
            {job.status === "failed" ? <Message kind="error" text={job.error ?? "Failed."} /> : null}
            {job.status === "cancelled" ? <Message kind="warning" text="Stopped. No file was left behind." /> : null}
          </View>
        ) : null}
        {error ? <Message kind="error" text={error} /> : null}
        <View style={[ui.row, { justifyContent: "flex-end", flexWrap: "wrap" }]}>
          {running && job ? <Btn label="Stop" kind="danger" onPress={() => void api.cancelJob({ id: job.id })} /> : null}
          <Btn label="Close" onPress={onClose} />
          <Btn
            icon="Copy"
            label="Copy, up to 5 MB"
            disabled={running}
            onPress={() =>
              void run(
                () => api.exportText({ source, format }),
                async (done) => {
                  await copyText(done.text ?? "");
                  toast.show(`Copied. ${done.message ?? ""}`, { variant: "success" });
                },
              )
            }
          />
          <Btn label="Save file" kind="primary" disabled={running || path.trim() === ""} onPress={() => void run(async () => (await api.startExport({ source, format, path })).job)} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

const IMPORT_FORMATS: { value: ImportFormat; label: string }[] = [
  { value: "csv", label: "CSV" },
  { value: "tsv", label: "TSV" },
  { value: "json", label: "JSON" },
  { value: "ndjson", label: "NDJSON" },
];

export function ImportModal({ connection, refObject, columns, onClose, onDone }: { connection: ConnectionView; refObject: ObjectRef; columns: string[]; onClose: () => void; onDone: () => void }) {
  const ui = useUi();
  const api = useApi();
  const guarded = useGuardedRun();
  const info = ENGINES[connection.engine];
  const [sourceKind, setSourceKind] = useState<"text" | "path">("text");
  const [value, setValue] = useState("");
  const [format, setFormat] = useState<ImportFormat>("csv");
  const [preview, setPreview] = useState<{ columns: string[]; rows: Record<string, unknown>[] } | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [emptyIsNull, setEmptyIsNull] = useState(true);
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const source = sourceKind === "text" ? { text: value } : { path: value };
  const running = job?.status === "running";
  // Where the object fixes its columns, map onto those. A schemaless object takes the source's names.
  const targets = columns.length > 0 ? [...new Set([...columns, ...(info.schemaless ? (preview?.columns ?? []) : [])])] : (preview?.columns ?? []);

  const loadPreview = async () => {
    setError(null);
    setJob(null);
    try {
      const answer = await api.importPreview({ source, format });
      setPreview(answer);
      const next: Record<string, string> = {};
      const lower = new Map(answer.columns.map((name) => [name.toLowerCase(), name]));
      for (const target of columns.length > 0 ? columns : answer.columns) {
        const match = lower.get(target.toLowerCase());
        if (match) next[target] = match;
      }
      if (info.schemaless) for (const name of answer.columns) next[name] ??= name;
      setMapping(next);
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  const start = async () => {
    setError(null);
    try {
      const done = await guarded(api, (confirmed) => api.startImport({ ref: refObject, source, options: { format, mapping, emptyIsNull }, confirmed }), setJob, setJob);
      if (done) {
        setJob(done);
        if (done.status === "done") onDone();
      }
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  return (
    <Modal title={`Import into ${refObject.name}`} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <View style={ui.wrap}>
          <Chip label="Paste" on={sourceKind === "text"} onPress={() => setSourceKind("text")} />
          <Chip label="File on the daemon machine" on={sourceKind === "path"} onPress={() => setSourceKind("path")} />
        </View>
        <View style={ui.wrap}>
          {IMPORT_FORMATS.map((item) => (
            <Chip key={item.value} label={item.label} on={format === item.value} onPress={() => setFormat(item.value)} />
          ))}
        </View>
        <Field label={sourceKind === "text" ? "Data" : "Full path"} value={value} onChangeText={setValue} multiline={sourceKind === "text"} mono />
        <Btn label="Preview" disabled={value.trim() === ""} onPress={() => void loadPreview()} />
        {preview ? (
          <View style={{ gap: 8 }}>
            <Text style={ui.muted}>
              First {preview.rows.length} record{preview.rows.length === 1 ? "" : "s"}. Example: {cellText(preview.rows[0] ?? null).slice(0, 200)}
            </Text>
            <Text style={ui.label}>Which source column fills each target?</Text>
            {targets.map((target) => (
              <View key={target} style={ui.row}>
                <Text numberOfLines={1} style={[ui.mono, { flex: 1 }]}>
                  {target}
                </Text>
                <View style={{ flex: 1 }}>
                  <Select
                    label={target}
                    value={mapping[target] ?? ""}
                    placeholder="Skip"
                    options={[{ label: "Skip", value: "" }, ...preview.columns.map((name) => ({ label: name, value: name }))]}
                    onChange={(next) =>
                      setMapping((current) => {
                        const copy = { ...current };
                        if (next === "") delete copy[target];
                        else copy[target] = next;
                        return copy;
                      })
                    }
                  />
                </View>
              </View>
            ))}
            {format === "csv" || format === "tsv" ? (
              <View style={ui.wrap}>
                <Chip label="Empty cell is NULL" on={emptyIsNull} onPress={() => setEmptyIsNull(true)} />
                <Chip label="Empty cell is empty text" on={!emptyIsNull} onPress={() => setEmptyIsNull(false)} />
              </View>
            ) : null}
            <Text style={ui.muted}>{info.transactionalImport ? "All or nothing: if a row fails, no rows are kept." : `${info.label} has no multi-row transaction here: if a row fails, rows before it stay.`}</Text>
          </View>
        ) : null}
        {job?.status === "running" ? <Message kind="note" text={`${job.rows} rows so far…`} /> : null}
        {job?.status === "done" ? <Message kind="success" text={job.message ?? "Done."} /> : null}
        {job?.status === "failed" ? <Message kind="error" text={job.error ?? "Failed."} /> : null}
        {job?.status === "cancelled" ? <Message kind="warning" text={info.transactionalImport ? "Stopped. No rows were kept." : `Stopped after ${job.rows} rows, which stay.`} /> : null}
        {error ? <Message kind="error" text={error} /> : null}
        <View style={[ui.row, { justifyContent: "flex-end" }]}>
          {running && job ? <Btn label="Stop" kind="danger" onPress={() => void api.cancelJob({ id: job.id })} /> : null}
          <Btn label="Close" onPress={onClose} />
          <Btn label="Import" kind="primary" disabled={!preview || running || job?.status === "done" || Object.keys(mapping).length === 0} onPress={() => void start()} />
        </View>
      </Modal.Content>
    </Modal>
  );
}
