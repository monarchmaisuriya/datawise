import { FlatList, Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { memo, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { ColumnInfo, Sort } from "../shared/contracts";
import { cellText, MONO, useUi } from "./kit";

const CHAR_WIDTH = 7.4;
const MIN_WIDTH = 70;
const MAX_WIDTH = 320;
const CHECK_WIDTH = 38;
const SAMPLE_ROWS = 50;

function widths(columns: ColumnInfo[], rows: unknown[][]): number[] {
  return columns.map((column, index) => {
    let longest = column.name.length + 3;
    for (const row of rows.slice(0, SAMPLE_ROWS)) longest = Math.max(longest, Math.min(cellText(row[index]).length, 60));
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, longest * CHAR_WIDTH + 20));
  });
}

interface GridProps {
  columns: ColumnInfo[];
  rows: unknown[][];
  cutCells?: [number, number][];
  sort?: Sort | null;
  onSort?: (column: string) => void;
  onRowPress?: (index: number) => void;
  // Present only when rows can be selected for bulk actions.
  selected?: ReadonlySet<number>;
  onToggle?: (index: number) => void;
}

const GridRow = memo(function GridRow({ row, index, sizes, cut, selected, selectable, onPress, onToggle }: { row: unknown[]; index: number; sizes: number[]; cut: ReadonlySet<number> | undefined; selected: boolean; selectable: boolean; onPress?: (index: number) => void; onToggle?: (index: number) => void }) {
  const ui = useUi();
  const c = ui.colors;
  return (
    <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: selected ? c.surface2 : "transparent" }}>
      {selectable ? (
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }} accessibilityLabel={`Select row ${index + 1}`} onPress={() => onToggle?.(index)} style={{ width: CHECK_WIDTH, alignItems: "center", justifyContent: "center" }}>
          <Icon name={selected ? "SquareCheck" : "Square"} size={15} color={selected ? c.accent : c.foregroundMuted} />
        </Pressable>
      ) : null}
      <Pressable accessibilityRole="button" accessibilityLabel={`Open row ${index + 1}`} disabled={!onPress} onPress={() => onPress?.(index)} style={({ pressed }) => ({ flexDirection: "row", backgroundColor: pressed ? c.surface1 : "transparent" })}>
        {row.map((cell, columnIndex) => (
          <View key={columnIndex} style={{ width: sizes[columnIndex], paddingHorizontal: 8, paddingVertical: ui.compact ? 10 : 6, borderRightWidth: 1, borderRightColor: c.border }}>
            <Text numberOfLines={1} style={{ fontFamily: MONO, fontSize: 12, color: cell === null ? c.foregroundMuted : c.foreground, fontStyle: cell === null ? "italic" : "normal" }}>
              {cell === null ? "NULL" : cellText(cell)}
              {cut?.has(columnIndex) ? " …" : ""}
            </Text>
          </View>
        ))}
      </Pressable>
    </View>
  );
});

export function Grid({ columns, rows, cutCells, sort, onSort, onRowPress, selected, onToggle }: GridProps) {
  const ui = useUi();
  const c = ui.colors;
  const sizes = useMemo(() => widths(columns, rows), [columns, rows]);
  const selectable = selected !== undefined;
  const total = sizes.reduce((sum, value) => sum + value, 0) + (selectable ? CHECK_WIDTH : 0);
  const cutByRow = useMemo(() => {
    const map = new Map<number, Set<number>>();
    for (const [rowIndex, columnIndex] of cutCells ?? []) {
      const set = map.get(rowIndex) ?? new Set<number>();
      set.add(columnIndex);
      map.set(rowIndex, set);
    }
    return map;
  }, [cutCells]);
  return (
    <ScrollView horizontal style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ flexGrow: 1 }}>
      <View style={{ minWidth: total, flex: 1, minHeight: 0 }}>
        <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface1 }}>
          {selectable ? <View style={{ width: CHECK_WIDTH }} /> : null}
          {columns.map((column, index) => {
            const sorted = sort?.column === column.name;
            return (
              <Pressable key={column.name} accessibilityRole="button" accessibilityLabel={onSort ? `Sort by ${column.name}` : column.name} disabled={!onSort} onPress={() => onSort?.(column.name)} style={{ width: sizes[index], flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 7, borderRightWidth: 1, borderRightColor: c.border }}>
                {column.isKey ? <Icon name="KeyRound" size={11} color={c.statusWarning} /> : null}
                <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 12, fontWeight: "600", color: c.foreground }}>
                  {column.name}
                </Text>
                {sorted ? <Icon name={sort?.descending ? "ArrowDown" : "ArrowUp"} size={11} color={c.accent} /> : null}
              </Pressable>
            );
          })}
        </View>
        <FlatList
          style={{ flex: 1, minHeight: 0 }}
          data={rows}
          keyExtractor={(_, index) => String(index)}
          initialNumToRender={40}
          renderItem={({ item, index }) => <GridRow row={item} index={index} sizes={sizes} cut={cutByRow.get(index)} selected={selected?.has(index) ?? false} selectable={selectable} onPress={onRowPress} onToggle={onToggle} />}
        />
      </View>
    </ScrollView>
  );
}
