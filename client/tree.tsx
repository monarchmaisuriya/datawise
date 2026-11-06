import { FlatList, Icon, TextInput } from "@getpaseo/plugin/client/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ConnectionView, ObjectInfo } from "../shared/contracts";
import { ENGINES } from "../shared/engines";
import { Btn, errorText, Message, Select, useApi, useUi } from "./kit";

export interface Place {
  database?: string;
  schema?: string;
}

const KIND_ICONS: Record<string, string> = { table: "Table2", view: "Eye", "materialized view": "Eye", collection: "FileJson", index: "Search", label: "Tag", hash: "Hash", list: "List", set: "Braces", zset: "ListOrdered", string: "Type", stream: "Activity" };

export function ObjectTree({ connection, place, onPlace, selected, onSelect, onBack, onEdit, onQuery }: { connection: ConnectionView; place: Place; onPlace: (place: Place) => void; selected: string | null; onSelect: (object: ObjectInfo) => void; onBack: () => void; onEdit: () => void; onQuery: (text?: string) => void }) {
  const ui = useUi();
  const api = useApi();
  const info = ENGINES[connection.engine];
  const [pattern, setPattern] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setSearch(pattern), 250);
    return () => clearTimeout(timer);
  }, [pattern]);

  const enabled = !connection.needsPassword;
  const databases = useQuery({ queryKey: ["datawise", connection.id, "databases"], queryFn: () => api.listDatabases({ connectionId: connection.id }), enabled: enabled && info.databaseLabel !== null, retry: false });
  const database = place.database ?? (connection.database || databases.data?.databases[0]);
  const databaseReady = info.databaseLabel === null || database !== undefined;
  const schemas = useQuery({ queryKey: ["datawise", connection.id, "schemas", database], queryFn: () => api.listSchemas({ connectionId: connection.id, database }), enabled: enabled && info.schemaLabel !== null && databaseReady, retry: false });
  const schema = place.schema ?? schemas.data?.schemas[0];
  const ready = enabled && databaseReady && (info.schemaLabel === null || schema !== undefined);

  // The parent needs the chosen level even when the user took the default.
  useEffect(() => {
    if (ready && (place.database !== database || place.schema !== schema)) onPlace({ database: info.databaseLabel ? database : undefined, schema: info.schemaLabel ? schema : undefined });
  }, [ready, database, schema, place.database, place.schema, info.databaseLabel, info.schemaLabel, onPlace]);

  const objects = useInfiniteQuery({
    queryKey: ["datawise", connection.id, "objects", database, schema, search],
    queryFn: ({ pageParam }) => api.listObjects({ connectionId: connection.id, database, schema, pattern: search, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: ready,
    retry: false,
  });
  const items = objects.data?.pages.flatMap((page) => page.objects) ?? [];
  const error = databases.error ?? schemas.error ?? objects.error;

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={[ui.toolbar, { flexWrap: "nowrap" }]}>
        <Btn icon="ArrowLeft" onPress={onBack} />
        <Text numberOfLines={1} style={[ui.title, { flex: 1 }]}>
          {connection.name}
        </Text>
        <Btn icon="Settings2" onPress={onEdit} />
      </View>
      <View style={{ padding: 8, gap: 6 }}>
        {info.databaseLabel && databases.data ? <Select label={info.databaseLabel} value={database ?? ""} options={databases.data.databases.map((name) => ({ label: name, value: name }))} onChange={(next) => onPlace({ database: next })} /> : null}
        {info.schemaLabel && schemas.data ? <Select label={info.schemaLabel} value={schema ?? ""} options={schemas.data.schemas.map((name) => ({ label: name, value: name }))} onChange={(next) => onPlace({ database, schema: next })} /> : null}
        <TextInput accessibilityLabel={`Find ${info.objectLabel}`} value={pattern} onChangeText={setPattern} placeholder={`Find ${info.objectLabel}`} placeholderTextColor={ui.colors.foregroundMuted} autoCapitalize="none" autoCorrect={false} style={ui.input} />
        <View style={ui.wrap}>
          <Btn icon="SquareTerminal" label="Query" onPress={() => onQuery()} />
          <Btn icon="Plus" label={`New ${info.objectLabel}`} onPress={() => onQuery(info.createTemplate)} />
          <Btn icon="RefreshCw" onPress={() => void objects.refetch()} />
        </View>
        {error ? <Message kind="error" text={errorText(error)} /> : null}
        {objects.isLoading ? <Message kind="note" text="Loading…" /> : null}
        {!objects.isLoading && !error && items.length === 0 ? <Message kind="note" text={`No ${info.objectLabel} found.`} /> : null}
      </View>
      <FlatList
        style={{ flex: 1, minHeight: 0 }}
        data={items}
        keyExtractor={(item) => item.name}
        ListFooterComponent={objects.hasNextPage ? <View style={{ padding: 8 }}><Btn label="Load more" onPress={() => void objects.fetchNextPage()} /></View> : null}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" accessibilityLabel={`Open ${item.name}`} onPress={() => onSelect(item)} style={({ pressed }) => [ui.row, { paddingHorizontal: 12, paddingVertical: ui.compact ? 11 : 6, backgroundColor: selected === item.name ? ui.colors.surface2 : pressed ? ui.colors.surface1 : "transparent" }]}>
            <Icon name={KIND_ICONS[item.kind] ?? "Box"} size={14} color={ui.colors.foregroundMuted} />
            <Text numberOfLines={1} style={[ui.body, { flex: 1 }]}>
              {item.name}
            </Text>
            {item.kind !== info.objectLabel ? <Text style={ui.muted}>{item.kind}</Text> : null}
          </Pressable>
        )}
      />
    </View>
  );
}
