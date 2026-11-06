function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  const text = typeof cell === "object" ? JSON.stringify(cell) : String(cell);
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

// A value too long for the grid reaches here cut, so it is marked. Pasted without the mark, it would look whole.
export function toMarkdownTable(names: string[], rows: unknown[][], positions: number[] = names.map((_, index) => index), cutCells: [number, number][] = []): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const isCut = (row: number, position: number) => cutCells.some(([cutRow, cutPosition]) => cutRow === row && cutPosition === position);
  return [
    line(positions.map((position) => cellText(names[position]))),
    line(positions.map(() => "---")),
    ...rows.map((row, index) => line(positions.map((position) => `${cellText(row[position])}${isCut(index, position) ? " … (cut)" : ""}`))),
  ].join("\n");
}
