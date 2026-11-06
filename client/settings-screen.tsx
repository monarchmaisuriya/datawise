import type { PluginSurfaceProps, SettingsState } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { ScrollView, SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import type { SafetyMode } from "../shared/contracts";
import { EXPORT_FORMATS, HISTORY_LENGTHS, IDLE_MINUTES, PAGE_SIZES, type Preferences, preferencesDocument, QUERY_LIMITS, TIME_LIMITS_MS } from "../shared/preferences";

type Ready = Extract<SettingsState<typeof preferencesDocument.schema>, { status: "ready" }>;

function numbers(values: readonly number[], label: (value: number) => string) {
  return values.map((value) => ({ value: String(value), label: label(value) }));
}

function minutes(ms: number): string {
  return ms < 60000 ? `${ms / 1000} s` : `${ms / 60000} min`;
}

function Controls({ settings }: { settings: Ready }) {
  const values = settings.values;
  const change = (patch: Partial<Preferences>) => void settings.save({ ...values, ...patch }, settings.revision);
  // Typed text is saved with a button, because saving on each key would race against its own revision.
  const [nullText, setNullText] = useState(values.nullText);
  const [exportFolder, setExportFolder] = useState(values.exportFolder);
  return (
    <>
      <SettingsSection title="Tables">
        <SettingsCard>
          <SettingsSelect label="Rows per page" value={String(values.rowsPerPage)} options={numbers(PAGE_SIZES, String)} onValueChange={(next) => change({ rowsPerPage: Number(next) })} />
          <SettingsSelect label="Row density" value={values.density} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }] as const} onValueChange={(density) => change({ density })} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Queries">
        <SettingsCard>
          <SettingsSelect label="Most rows to show" value={String(values.queryRowLimit)} options={numbers(QUERY_LIMITS, String)} onValueChange={(next) => change({ queryRowLimit: Number(next) })} />
          <SettingsSelect label="Time limit" value={String(values.queryTimeLimitMs)} options={numbers(TIME_LIMITS_MS, minutes)} onValueChange={(next) => change({ queryTimeLimitMs: Number(next) })} />
          <SettingsSwitch label="Keep query history" hint="Off stops new entries. What is there stays until you clear it." value={values.keepHistory} onValueChange={(keepHistory) => change({ keepHistory })} />
          <SettingsSelect label="History length" hint="Applied to every connection when changed. 0 keeps none." value={String(values.historyLength)} options={numbers(HISTORY_LENGTHS, String)} onValueChange={(next) => change({ historyLength: Number(next) })} />
          <SettingsSwitch label="Save query drafts" hint="Off keeps tab names and not their text." value={values.keepDrafts} onValueChange={(keepDrafts) => change({ keepDrafts })} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Connections">
        <SettingsCard>
          <SettingsSelect<SafetyMode> label="Write mode for new connections" hint="Existing connections keep their own." value={values.newConnectionSafety} options={[{ value: "read-only", label: "Read-only" }, { value: "confirm", label: "Ask first" }, { value: "open", label: "No prompts" }]} onValueChange={(newConnectionSafety) => change({ newConnectionSafety })} />
          <SettingsSelect label="Close idle connections after" value={String(values.idleCloseMinutes)} options={numbers(IDLE_MINUTES, (value) => `${value} min`)} onValueChange={(next) => change({ idleCloseMinutes: Number(next) })} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Export and display">
        <SettingsCard>
          <SettingsSelect label="Export format" hint="Falls back to CSV on a database without SQL inserts." value={values.exportFormat} options={EXPORT_FORMATS.map((value) => ({ value, label: value.toUpperCase() }))} onValueChange={(exportFormat) => change({ exportFormat })} />
          <SettingsInput label="Export folder" hint="An absolute path or ~/folder. Empty means ~/Downloads/datawise." initialValue={values.exportFolder} onChangeText={setExportFolder} placeholder="~/Downloads/datawise" />
          <SettingsInput label="How NULL is shown" hint="Up to 12 characters. Empty means NULL, so a NULL never looks like empty text." initialValue={values.nullText} onChangeText={(text) => setNullText(text.slice(0, 12))} />
          <SettingsAction label="Save the two text settings above" actionLabel="Save" error={settings.saveError} disabled={settings.saving} onPress={() => change({ nullText, exportFolder })} />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}

export function SettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferencesDocument);
  return (
    <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ gap: 16 }}>
      {settings.status === "ready" ? <Controls settings={settings} /> : null}
      {settings.status === "error" || settings.status === "invalid" ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>These settings could not be read, so Datawise is using its defaults: {settings.error}</Text>
          <SettingsAction label="Start again from the defaults" actionLabel="Reset" onPress={() => void settings.reset()} />
        </View>
      ) : null}
    </ScrollView>
  );
}
