import { FlatList, Icon, ScrollView } from "@getpaseo/plugin/client/ui";
import { memo, useMemo, useRef, useState } from "react";
import { type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent, PanResponder, Platform, Pressable, Text, View } from "react-native";
import type { ColumnInfo, Sort } from "../shared/contracts";
import { clampWidth } from "../shared/column-width";
import { bytesOf, columnRange, groupDigits, hexPreview } from "../shared/grid-display";
import { TEXT_SIZES } from "../shared/preferences";
import { cellText, MONO, useUi } from "./kit";
import { usePreferences } from "./preferences";

const MIN_WIDTH = 70;
const MAX_WIDTH = 320;
const CHECK_WIDTH = 38;
const SAMPLE_ROWS = 50;
// Before the grid has measured itself, it draws as if this wide.
const FIRST_GUESS_WIDTH = 1600;
const DOUBLE_PRESS_MS = 350;

// Dragging a header edge needs a mouse or trackpad. A touch screen's scroll view takes the drag, so touch
// layouts set widths in the Columns dialog instead.
export function usePointerResize(): boolean {
  return Platform.OS === "web" && !useUi().compact;
}

// Widths sized to the content, used for any column without a saved width.
export function autoWidths(columns: ColumnInfo[], rows: unknown[][], fontSize: number): number[] {
  const charWidth = (7.4 * fontSize) / 12;
  return columns.map((column, index) => {
    let longest = column.name.length + 3;
    for (const row of rows.slice(0, SAMPLE_ROWS)) longest = Math.max(longest, Math.min(cellText(row[index]).length, 60));
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, longest * charWidth + 20));
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
  // Widths chosen by the person, by column name. With onResize, header edges can be dragged on wide screens.
  savedWidths?: Readonly<Record<string, number>>;
  onResize?: (column: string, width: number | null) => void;
}

function displayText(cell: unknown, column: ColumnInfo | undefined, groupNumbers: boolean, binaryAsHex: boolean): string {
  if (groupNumbers && typeof cell === "number" && !column?.isKey) return groupDigits(cell);
  const bytes = binaryAsHex ? bytesOf(cell) : null;
  return bytes === null ? cellText(cell) : hexPreview(bytes.base64, bytes.size);
}

const GridRow = memo(function GridRow({ row, index, columns, sizes, shown, leftPad, rightPad, cut, selected, selectable, edited, deleted, onPress, onCellPress, onToggle }: { row: unknown[]; index: number; columns: ColumnInfo[]; sizes: number[]; shown: number[]; leftPad: number; rightPad: number; cut: ReadonlySet<number> | undefined; selected: boolean; selectable: boolean; edited: ReadonlySet<number> | undefined; deleted: boolean; onPress?: (index: number) => void; onCellPress?: (index: number, column: number) => void; onToggle?: (index: number) => void }) {
  const ui = useUi();
  const { density, nullText, textSize, groupDigits: groupNumbers, binaryDisplay } = usePreferences();
  const c = ui.colors;
  const padding = ui.compact ? (density === "compact" ? 6 : 10) : density === "compact" ? 3 : 6;
  const cells = shown.map((position) => {
    const cell = row[position];
    const style = { width: sizes[position], paddingHorizontal: 8, paddingVertical: padding, backgroundColor: edited?.has(position) ? c.surface2 : "transparent" };
    const label = (
      <Text numberOfLines={1} style={{ fontFamily: MONO, fontSize: TEXT_SIZES[textSize], color: cell === null ? c.foregroundMuted : c.foreground, fontStyle: cell === null ? "italic" : "normal", textDecorationLine: deleted ? "line-through" : "none" }}>
        {cell === null ? nullText : displayText(cell, columns[position], groupNumbers, binaryDisplay === "hex")}
        {cut?.has(position) ? " …" : ""}
      </Text>
    );
    return onCellPress ? (
      <Pressable key={position} accessibilityRole="button" accessibilityLabel={`Edit ${columns[position]?.name} in row ${index + 1}`} onPress={() => onCellPress(index, position)} style={style}>
        {label}
      </Pressable>
    ) : (
      <View key={position} style={style}>
        {label}
      </View>
    );
  });
  const padded = (
    <>
      <View style={{ width: leftPad }} />
      {cells}
      <View style={{ width: rightPad }} />
    </>
  );
  return (
    <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: selected ? c.surface2 : "transparent" }}>
      {selectable ? (
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }} accessibilityLabel={`Select row ${index + 1}`} onPress={() => onToggle?.(index)} style={{ width: CHECK_WIDTH, alignItems: "center", justifyContent: "center" }}>
          <Icon name={selected ? "SquareCheck" : "Square"} size={15} color={selected ? c.foreground : c.foregroundMuted} />
        </Pressable>
      ) : null}
      {onCellPress ? (
        <View style={{ flexDirection: "row" }}>{padded}</View>
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel={`Open row ${index + 1}`} disabled={!onPress} onPress={() => onPress?.(index)} style={({ pressed }) => ({ flexDirection: "row", backgroundColor: pressed ? c.surface1 : "transparent" })}>
          {padded}
        </Pressable>
      )}
    </View>
  );
});

// Drags a header's right edge. The width shown while dragging is kept here, and saved once on release.
function ResizeHandle({ column, width, onLive, onResize }: { column: string; width: number; onLive: (width: number | null) => void; onResize: (column: string, width: number | null) => void }) {
  const ui = useUi();
  const start = useRef(width);
  const lastRelease = useRef(0);
  const latest = useRef({ width, onLive, onResize });
  latest.current = { width, onLive, onResize };
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          start.current = latest.current.width;
        },
        onPanResponderMove: (_, gesture) => latest.current.onLive(clampWidth(start.current + gesture.dx)),
        onPanResponderRelease: (_, gesture) => {
          latest.current.onLive(null);
          const now = Date.now();
          if (Math.abs(gesture.dx) < 3) {
            // A double press puts the column back to its automatic width.
            if (now - lastRelease.current < DOUBLE_PRESS_MS) latest.current.onResize(column, null);
            lastRelease.current = now;
            return;
          }
          latest.current.onResize(column, clampWidth(start.current + gesture.dx));
        },
        onPanResponderTerminate: () => latest.current.onLive(null),
      }),
    [column],
  );
  return (
    <View {...responder.panHandlers} accessibilityLabel={`Resize ${column}. Double press for automatic width.`} style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 9, alignItems: "flex-end" }}>
      <View style={{ width: 1, flex: 1, marginVertical: 6, backgroundColor: ui.colors.border }} />
    </View>
  );
}

export function Grid({ columns, rows, cutCells, sort, onSort, onRowPress, selected, onToggle, visible, onCellPress, editedCells, deletedRows, savedWidths, onResize }: GridProps) {
  const ui = useUi();
  const c = ui.colors;
  const { textSize } = usePreferences();
  const fontSize = TEXT_SIZES[textSize];
  const pointerResize = usePointerResize();
  const automatic = useMemo(() => autoWidths(columns, rows, fontSize), [columns, rows, fontSize]);
  const [live, setLive] = useState<{ column: string; width: number } | null>(null);
  const sizes = useMemo(
    () =>
      columns.map((column, index) => {
        if (live?.column === column.name) return live.width;
        const saved = savedWidths?.[column.name];
        return saved === undefined ? (automatic[index] ?? MIN_WIDTH) : clampWidth(saved);
      }),
    [columns, automatic, savedWidths, live],
  );
  const selectable = selected !== undefined;
  const positions = useMemo(() => visible ?? columns.map((_, index) => index), [visible, columns]);
  const ordered = useMemo(() => positions.map((position) => sizes[position] ?? 0), [positions, sizes]);
  const starts = useMemo(() => {
    const result = [0];
    for (const width of ordered) result.push((result[result.length - 1] as number) + width);
    return result;
  }, [ordered]);
  const columnsWidth = starts[starts.length - 1] as number;
  const total = columnsWidth + (selectable ? CHECK_WIDTH : 0);

  // Only columns near the view are drawn. The range changes by whole columns, so rows re-render rarely.
  const view = useRef({ x: 0, width: FIRST_GUESS_WIDTH });
  // Clamped, because columns can shrink under a scroll position no scroll event has corrected yet.
  const wanted = () => {
    const x = Math.min(view.current.x, Math.max(0, columnsWidth - view.current.width));
    return columnRange(ordered, x - view.current.width, x + 2 * view.current.width);
  };
  const [range, setRange] = useState(wanted);
  const fit = () => {
    const next = wanted();
    setRange((now) => (now.first === next.first && now.last === next.last ? now : next));
  };
  // Columns or widths can change under a stored range, so it is checked while rendering too.
  const current = wanted();
  if (current.first !== range.first || current.last !== range.last) setRange(current);
  const shown = useMemo(() => positions.slice(range.first, range.last + 1), [positions, range]);
  const leftPad = starts[range.first] ?? 0;
  const rightPad = columnsWidth - (starts[range.last + 1] ?? columnsWidth);
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    view.current.x = event.nativeEvent.contentOffset.x - (selectable ? CHECK_WIDTH : 0);
    fit();
  };
  const onLayout = (event: LayoutChangeEvent) => {
    view.current.width = event.nativeEvent.layout.width;
    fit();
  };

  const cutByRow = useMemo(() => {
    const map = new Map<number, Set<number>>();
    for (const [rowIndex, columnIndex] of cutCells ?? []) {
      const set = map.get(rowIndex) ?? new Set<number>();
      set.add(columnIndex);
      map.set(rowIndex, set);
    }
    return map;
  }, [cutCells]);
  const resizable = onResize !== undefined && pointerResize;
  return (
    <ScrollView horizontal style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ flexGrow: 1 }} onScroll={onScroll} onLayout={onLayout} scrollEventThrottle={32}>
      <View style={{ minWidth: total, flex: 1, minHeight: 0 }}>
        <View style={{ flexDirection: "row", borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface1 }}>
          {selectable ? <View style={{ width: CHECK_WIDTH }} /> : null}
          <View style={{ width: leftPad }} />
          {shown.map((position) => {
            const column = columns[position];
            if (!column) return null;
            const sorted = sort?.column === column.name;
            return (
              <View key={column.name} style={{ width: sizes[position] }}>
                <Pressable accessibilityRole="button" accessibilityLabel={onSort ? `Sort by ${column.name}` : column.name} disabled={!onSort} onPress={() => onSort?.(column.name)} style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 7 }}>
                  {column.isKey ? <Icon name="KeyRound" size={11} color={c.statusWarning} /> : null}
                  <Text numberOfLines={1} style={{ flexShrink: 1, fontSize, fontWeight: "600", color: c.foreground }}>
                    {column.name}
                  </Text>
                  {sorted ? <Icon name={sort?.descending ? "ArrowDown" : "ArrowUp"} size={11} color={c.foreground} /> : null}
                </Pressable>
                {resizable ? <ResizeHandle column={column.name} width={sizes[position] ?? MIN_WIDTH} onLive={(width) => setLive(width === null ? null : { column: column.name, width })} onResize={onResize} /> : null}
              </View>
            );
          })}
          <View style={{ width: rightPad }} />
        </View>
        <FlatList
          style={{ flex: 1, minHeight: 0 }}
          data={rows}
          keyExtractor={(_, index) => String(index)}
          // About a screen at first, then three screens kept around the one in view.
          initialNumToRender={30}
          windowSize={7}
          maxToRenderPerBatch={20}
          extraData={shown}
          renderItem={({ item, index }) => <GridRow row={item} index={index} columns={columns} sizes={sizes} shown={shown} leftPad={leftPad} rightPad={rightPad} cut={cutByRow.get(index)} selected={selected?.has(index) ?? false} selectable={selectable} edited={editedCells?.get(index)} deleted={deletedRows?.has(index) ?? false} onPress={onRowPress} onCellPress={onCellPress} onToggle={onToggle} />}
        />
      </View>
    </ScrollView>
  );
}
