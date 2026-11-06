import { FlatList, Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { memo, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import type { ColumnInfo, Sort } from "../shared/contracts";
import { cellText, MONO, useUi } from "./kit";
import { usePreferences } from "./preferences";

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
  // Raw positions in display order. Rows and cut cells keep raw positions, so hiding a column cannot move a value.
  visible?: number[];
  // Replaces opening the row, when cells are edited one at a time.
  onCellPress?: (index: number, column: number) => void;
  // Rows with pending edits, shown as they will be and not as they are stored.
  editedCells?: ReadonlyMap<number, ReadonlySet<number>>;
  deletedRows?: ReadonlySet<number>;
}

const GridRow = memo(function GridRow({ row, index, names, sizes, positions, cut, selected, selectable, edited, deleted, onPress, onCellPress, onToggle }: { row: unknown[]; index: number; names: string[]; sizes: number[]; positions: number[]; cut: ReadonlySet<number> | undefined; selected: boolean; selectable: boolean; edited: ReadonlySet<number> | undefined; deleted: boolean; onPress?: (index: number) => void; onCellPress?: (index: number, column: number) => void; onToggle?: (index: number) => void }) {
  const ui = useUi();
  const { density, nullText } = usePreferences();
  const c = ui.colors;
  const padding = ui.compact ? (density === "compact" ? 6 : 10) : density === "compact" ? 3 : 6;
  const cells = positions.map((position) => {
    const cell = row[position];
    const style = { width: sizes[position], paddingHorizontal: 8, paddingVertical: padding, backgroundColor: edited?.has(position) ? c.surface2 : "transparent" };
    const label = (
      <Text numberOfLines={1} style={{ fontFamily: MONO, fontSize: 12, color: cell === null ? c.foregroundMuted : c.foreground, fontStyle: cell === null ? "italic" : "normal", textDecorationLine: deleted ? "line-through" : "none" }}>
        {cell === null ? nullText : cellText(cell)}
        {cut?.has(position) ? " …" : ""}
      </Text>
    );
    return onCellPress ? (
      <Pressable key={position} accessibilityRole="button" accessibilityLabel={`Edit ${names[position]} in row ${index + 1}`} onPress={() => onCellPress(index, position)} style={style}>
        {label}
      </Pressable>
    ) : (
      <View key={position} style={style}>
        {label}
      </View>
    );
  });
  return (
    <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: selected ? c.surface2 : "transparent" }}>
      {selectable ? (
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }} accessibilityLabel={`Select row ${index + 1}`} onPress={() => onToggle?.(index)} style={{ width: CHECK_WIDTH, alignItems: "center", justifyContent: "center" }}>
          <Icon name={selected ? "SquareCheck" : "Square"} size={15} color={selected ? c.foreground : c.foregroundMuted} />
        </Pressable>
      ) : null}
      {onCellPress ? (
        <View style={{ flexDirection: "row" }}>{cells}</View>
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel={`Open row ${index + 1}`} disabled={!onPress} onPress={() => onPress?.(index)} style={({ pressed }) => ({ flexDirection: "row", backgroundColor: pressed ? c.surface1 : "transparent" })}>
          {cells}
        </Pressable>
      )}
    </View>
  );
});

export function Grid({ columns, rows, cutCells, sort, onSort, onRowPress, selected, onToggle, visible, onCellPress, editedCells, deletedRows }: GridProps) {
  const ui = useUi();
  const c = ui.colors;
  const sizes = useMemo(() => widths(columns, rows), [columns, rows]);
  const selectable = selected !== undefined;
  const names = useMemo(() => columns.map((column) => column.name), [columns]);
  const positions = useMemo(() => visible ?? columns.map((_, index) => index), [visible, columns]);
  const total = positions.reduce((sum, position) => sum + (sizes[position] ?? 0), 0) + (selectable ? CHECK_WIDTH : 0);
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
          {positions.map((position) => {
            const column = columns[position];
            if (!column) return null;
            const sorted = sort?.column === column.name;
            return (
              <Pressable key={column.name} accessibilityRole="button" accessibilityLabel={onSort ? `Sort by ${column.name}` : column.name} disabled={!onSort} onPress={() => onSort?.(column.name)} style={{ width: sizes[position], flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 7 }}>
                {column.isKey ? <Icon name="KeyRound" size={11} color={c.statusWarning} /> : null}
                <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 12, fontWeight: "600", color: c.foreground }}>
                  {column.name}
                </Text>
                {sorted ? <Icon name={sort?.descending ? "ArrowDown" : "ArrowUp"} size={11} color={c.foreground} /> : null}
              </Pressable>
            );
          })}
        </View>
        <FlatList
          style={{ flex: 1, minHeight: 0 }}
          data={rows}
          keyExtractor={(_, index) => String(index)}
          initialNumToRender={40}
          extraData={positions}
          renderItem={({ item, index }) => <GridRow row={item} index={index} names={names} sizes={sizes} positions={positions} cut={cutByRow.get(index)} selected={selected?.has(index) ?? false} selectable={selectable} edited={editedCells?.get(index)} deleted={deletedRows?.has(index) ?? false} onPress={onRowPress} onCellPress={onCellPress} onToggle={onToggle} />}
        />
      </View>
    </ScrollView>
  );
}
