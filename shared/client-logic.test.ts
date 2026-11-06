import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentRowAccessRefusal, agentRowLevel } from "./agent-access";
import { visibleText, visibleValue } from "./agent-display";
import { jumpFilters } from "./foreign-keys";
import { toMarkdownTable } from "./markdown";
import { stageCell, stageDelete, toEdits } from "./staging";
import { dropMissingColumns, visiblePositions } from "./view-columns";

describe("visible columns", () => {
  it("keeps raw positions, so a hidden key does not move any other cell", () => {
    expect(visiblePositions(["id", "name", "note"], { hiddenColumns: ["id"], columnOrder: [] })).toEqual([1, 2]);
  });
  it("applies a saved order and ignores columns that no longer exist", () => {
    expect(visiblePositions(["id", "name", "note"], { hiddenColumns: [], columnOrder: ["note", "gone", "id"] })).toEqual([2, 0, 1]);
  });
  it("shows everything rather than an empty grid", () => {
    expect(visiblePositions(["id"], { hiddenColumns: ["id"], columnOrder: [] })).toEqual([0]);
  });
});

describe("a saved view on a changed table", () => {
  it("drops a sort and filter on a missing column and names it", () => {
    const answer = dropMissingColumns(["id"], { column: "gone", descending: false }, [{ column: "gone", op: "eq", value: "1" }, { column: "id", op: "eq", value: "2" }]);
    expect(answer).toEqual({ sort: null, filters: [{ column: "id", op: "eq", value: "2" }], dropped: ["gone"] });
  });
});

describe("pending edits", () => {
  const key = { id: 1 };
  it("merges edits to one row and keeps the first value seen", () => {
    let rows = stageCell(new Map(), key, "name", "a", "b");
    rows = stageCell(rows, key, "name", "b", "c");
    expect(toEdits(rows)).toEqual([{ kind: "update", key, original: { name: "a" }, changes: { name: "c" } }]);
  });
  it("forgets an edit put back to its first value", () => {
    const rows = stageCell(stageCell(new Map(), key, "name", "a", "b"), key, "name", "b", "a");
    expect(toEdits(rows)).toEqual([]);
  });
  it("lets a delete win over an update", () => {
    const rows = stageDelete(stageCell(new Map(), key, "name", "a", "b"), [{ key, seen: { id: 1, name: "b", note: "n" } }]);
    expect(toEdits(rows)).toEqual([{ kind: "delete", key, original: { id: 1, name: "a", note: "n" } }]);
  });
  it("treats a column named like an object property as an ordinary column", () => {
    expect(toEdits(stageCell(new Map(), key, "constructor", "a", "b"))).toEqual([{ kind: "update", key, original: { constructor: "a" }, changes: { constructor: "b" } }]);
  });
  it("refuses a key edit, so a key can never come to name another row", () => {
    expect(() => stageCell(new Map(), key, "id", 1, 2)).toThrow(/key column id/);
  });
});

describe("foreign key jumps", () => {
  const fk = { name: "fk", columns: ["a", "b"], references: "t (x, y)", targetDatabase: null, targetSchema: null, targetTable: "t", targetColumns: ["x", "y"] };
  it("filters on every column of a composite key", () => {
    expect(jumpFilters(fk, (column) => (column === "a" ? 1 : "two"))).toEqual([{ column: "x", op: "eq", value: "1" }, { column: "y", op: "eq", value: "two" }]);
  });
  it("offers nothing when any column is null", () => {
    expect(jumpFilters(fk, (column) => (column === "a" ? 1 : null))).toBeNull();
  });
  it("offers nothing when the target is unknown", () => {
    expect(jumpFilters({ ...fk, targetTable: null }, () => 1)).toBeNull();
  });
});

describe("markdown tables", () => {
  it("marks a value that reached the client cut", () => {
    expect(toMarkdownTable(["a", "b"], [["short", "long"]], [0, 1], [[0, 1]])).toBe("| a | b |\n| --- | --- |\n| short | long … (cut) |");
  });
  it("escapes pipes and new lines and honours column order", () => {
    expect(toMarkdownTable(["a", "b"], [["x|y", "1\n2"]], [1, 0])).toBe("| b | a |\n| --- | --- |\n| 1<br>2 | x\\|y |");
  });
});

describe("values on the approval screen", () => {
  it("shows a line break as a code, so a value cannot look like another change", () => {
    expect(visibleValue("a\nDELETE FROM users")).toBe('"a\\nDELETE FROM users"');
  });
  it("keeps apart values that would otherwise look the same", () => {
    expect(visibleValue(null)).toBe("NULL");
    expect(visibleValue("NULL")).toBe('"NULL"');
    expect(visibleValue(1)).toBe("1");
    expect(visibleValue("1")).toBe('"1"');
    expect(visibleValue("admin ")).toBe('"admin "');
    expect(visibleValue("a\\nb")).not.toBe(visibleValue("a\nb"));
  });
  it("shows characters that hide as codes", () => {
    expect(visibleValue("safe‮gnp.exe​")).toBe('"safe\\u{202e}gnp.exe\\u{200b}"');
    expect(visibleValue("a bㅤc️")).toBe('"a\\u{a0}b\\u{3164}c\\u{fe0f}"');
    expect(visibleText("x\u{e0041}y")).toBe("x\\u{e0041}y");
  });
  it("draws bytes as a size and a start", () => {
    expect(visibleValue({ "$datawise.bytes": "UExBTlRFREJZVEVT" })).toBe("<12 bytes, starting UExBTlRFREJZVEVT>");
  });
});

describe("agent access to rows", () => {
  const base = { engine: "postgres" as const, environment: "development" as const, safety: "confirm" as const, agentAccess: "schema" as const, agentRowAccess: "propose" as const };
  it("allows a labelled connection", () => {
    expect(agentRowAccessRefusal(base)).toBeNull();
    expect(agentRowLevel(base)).toBe("propose");
  });
  it("refuses production and no label", () => {
    expect(agentRowAccessRefusal({ ...base, environment: "production" })).toMatch(/development or staging/);
    expect(agentRowAccessRefusal({ ...base, environment: "none" })).toMatch(/development or staging/);
    expect(agentRowLevel({ ...base, environment: "production" })).toBe("none");
  });
  it("refuses an engine without transactions across rows", () => {
    expect(agentRowAccessRefusal({ ...base, engine: "clickhouse" })).toMatch(/does not support/);
    expect(agentRowLevel({ ...base, engine: "mongodb" })).toBe("none");
  });
  it("needs names shared first", () => {
    expect(agentRowAccessRefusal({ ...base, agentAccess: "none" })).toMatch(/Share table and column names/);
  });
  it("gives a read-only connection reads, never proposals", () => {
    expect(agentRowAccessRefusal({ ...base, safety: "read-only" })).toMatch(/read-only/);
    expect(agentRowLevel({ ...base, safety: "read-only" })).toBe("read");
  });
});

describe("dialogs", () => {
  it("all go through the wrapper that restores our contexts, or a phone crashes when one opens", () => {
    const folder = join(__dirname, "..", "client");
    const offenders = readdirSync(folder).filter((file) => {
      const source = readFileSync(join(folder, file), "utf8");
      return file !== "kit.tsx" && /import \{[^}]*\bModal\b[^}]*\} from "@getpaseo\/plugin\/client\/ui"/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});
