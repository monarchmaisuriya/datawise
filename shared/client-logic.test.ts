import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentRowAccessRefusal, agentRowLevel, rowAccessPossible } from "./agent-access";
import { ENGINE_IDS } from "./engines";
import { visibleText, visibleValue } from "./agent-display";
import { jumpFilters } from "./foreign-keys";
import { clampWidth } from "./column-width";
import { AGENT_OPEN_KEPT_MS, agentActivityEvent, agentEvent, agentOpenEvent, savedView } from "./contracts";
import { productionQuestion, receiveAgentOpen, takeAgentOpen } from "../client/agent-open";
import { answered, asked } from "../client/confirm-state";
import { movesSecrets, proposalNote } from "../client/proposal-note";
import { applyAgentTabs } from "../client/agent-push";
import { wholeKey } from "./row-key";
import { columnRange, groupDigits, hexPreview } from "./grid-display";
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
  it("allows names and rows on every engine, never on production", () => {
    for (const engine of ENGINE_IDS) {
      expect(agentRowAccessRefusal({ ...base, engine, agentRowAccess: "read" })).toBeNull();
      expect(agentRowLevel({ ...base, engine, agentRowAccess: "read" })).toBe("read");
      expect(rowAccessPossible("production")).toBe(false);
      expect(rowAccessPossible("staging")).toBe(true);
    }
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

describe("saved column widths", () => {
  it("are clamped or dropped one by one, so a bad value never sets every view aside", () => {
    expect(savedView.parse({ columnWidths: { a: 5000, b: "wide", c: -3, d: 150 } }).columnWidths).toEqual({ a: 800, c: 60, d: 150 });
    expect(savedView.parse({}).columnWidths).toEqual({});
  });
});

describe("agent activity written by an older Datawise", () => {
  it("reads a count without a unit as rows", () => {
    const old = { at: "2026-11-01T00:00:00.000Z", agentId: "a", agentTitle: null, connectionId: "c", connectionName: "Dev", action: "proposed", place: "users", rows: 2 };
    expect(agentActivityEvent.parse(old).unit).toBe("rows");
  });
});

describe("an agent's request to open a tab", () => {
  afterEach(() => vi.useRealTimers());
  const place = { connectionId: "c", object: null, tab: "data" as const };
  it("moves no window for production, so nothing changes before the person says yes", () => {
    expect(receiveAgentOpen({ workspaceId: "w1", place, text: null, production: null })).toBe(true);
    expect(receiveAgentOpen({ workspaceId: "w2", place, text: null, production: { agentTitle: "A", connectionName: "Live" } })).toBe(false);
    expect(takeAgentOpen("w2")?.production).toEqual({ agentTitle: "A", connectionName: "Live" });
  });
  it("asks about production with the agent's words shown as codes, and says when query text comes too", () => {
    const question = productionQuestion({ workspaceId: "w", place, text: "select 1", production: { agentTitle: "A\nOpen", connectionName: "Live" } });
    expect(question).toBe('"A\\nOpen" wants to open "Live". It also puts query text in a tab; nothing runs.');
    expect(productionQuestion({ workspaceId: "w", place, text: null, production: { agentTitle: "A", connectionName: "Live" } })).toBe('"A" wants to open "Live".');
  });
  it("is dropped once it has waited too long, so an old question never appears later", () => {
    vi.useFakeTimers();
    receiveAgentOpen({ workspaceId: "w3", place, text: null, production: { agentTitle: "A", connectionName: "Live" } });
    vi.advanceTimersByTime(AGENT_OPEN_KEPT_MS + 1);
    expect(takeAgentOpen("w3")).toBeNull();
  });
});

describe("the confirm dialog", () => {
  const question = { title: "Open a production connection?", preview: "A wants to open Live.", actionLabel: "Open" };
  it("closes on an answer but keeps showing its own words while it fades, never a default", () => {
    const open = asked({ ...question, resolve: () => undefined });
    expect(open.pending).not.toBeNull();
    const closing = answered(open);
    expect(closing.pending).toBeNull();
    expect(closing.shown).toEqual(question);
  });
});

describe("an agent's connection proposal in the form", () => {
  it("knows when a proposal moves where the saved password would go", () => {
    expect(movesSecrets({ host: "b.example" }, { host: "a.example" } as never)).toBe(true);
    expect(movesSecrets({ host: "a.example", group: "Team" }, { host: "a.example", group: "" } as never)).toBe(false);
    expect(movesSecrets({ ssh: { host: "jump", port: 22, user: "u" } }, { ssh: null } as never)).toBe(true);
    expect(movesSecrets({ host: "b.example" }, null)).toBe(false);
  });
  it("lists the host first, with the value each proposal replaces, and shows hidden characters as codes", () => {
    const note = proposalNote({ port: 6543, host: "evil\u202e.example" }, { host: "db.example", port: 5432 } as never);
    expect(note.split("\n").slice(1)).toEqual(["host: evil\\u{202e}.example (now db.example)", "port: 6543 (now 5432)"]);
  });
});

describe("an agent's change to a window's query tabs", () => {
  const state = { activeId: "a", tabs: [{ id: "a", name: "One", text: "select 1" }, { id: "b", name: "Two", text: "" }] };
  it("renames, and closes a tab only while its text is what the server saw", () => {
    expect(applyAgentTabs(state, { kind: "tabs", connectionId: "c", renamed: [{ id: "b", name: "New" }], closed: [] }).tabs.map((tab) => tab.name)).toEqual(["One", "New"]);
    expect(applyAgentTabs(state, { kind: "tabs", connectionId: "c", renamed: [], closed: [{ id: "a", text: "" }] }).tabs).toHaveLength(2);
    expect(applyAgentTabs(state, { kind: "tabs", connectionId: "c", renamed: [], closed: [{ id: "a", text: "select 1" }] })).toEqual({ activeId: "b", tabs: [{ id: "b", name: "Two", text: "" }] });
  });
  it("never closes the last tab", () => {
    expect(applyAgentTabs(state, { kind: "tabs", connectionId: "c", renamed: [], closed: [{ id: "a", text: "select 1" }, { id: "b", text: "" }] })).toBe(state);
  });
});

describe("events to open windows", () => {
  const tabs = { kind: "tabs", connectionId: "c", renamed: [], closed: [] };
  const open = { workspaceId: "w", place: { connectionId: "c", object: null, tab: "data" }, text: null, production: null };
  it("parse as tab, view or open events, and an open event keeps its old shape", () => {
    expect(agentEvent.parse(tabs)).toMatchObject({ kind: "tabs" });
    expect(agentEvent.parse({ kind: "view", ref: { connectionId: "c", name: "t" }, sort: null })).toMatchObject({ kind: "view" });
    expect(agentEvent.parse(open)).not.toHaveProperty("kind");
  });
  it("are refused by a window still on the old schema, whose subscription then closes and reopens after 5 seconds", () => {
    expect(agentOpenEvent.safeParse(tabs).success).toBe(false);
    expect(agentOpenEvent.safeParse(open).success).toBe(true);
  });
});

describe("grid display", () => {
  it("draws the columns that overlap the range, and at least one", () => {
    expect(columnRange([100, 100, 100, 100], 150, 250)).toEqual({ first: 1, last: 2 });
    expect(columnRange([100, 100, 100], -500, 50)).toEqual({ first: 0, last: 0 });
    expect(columnRange([100, 100], 900, 1200)).toEqual({ first: 1, last: 1 });
    expect(columnRange([], 0, 100)).toEqual({ first: 0, last: -1 });
  });
  it("clamps a saved width instead of refusing it", () => {
    expect(clampWidth(5)).toBe(60);
    expect(clampWidth(5000)).toBe(800);
    expect(clampWidth(123.6)).toBe(124);
  });
  it("groups digits of numbers, and leaves other forms as they are", () => {
    expect(groupDigits(1234567.25)).toBe("1,234,567.25");
    expect(groupDigits(-1000)).toBe("-1,000");
    expect(groupDigits(999)).toBe("999");
    expect(groupDigits(1e21)).toBe("1e+21");
  });
  it("shows the first bytes as hex and says how many there are", () => {
    expect(hexPreview("AP8=", 2)).toBe("00 ff");
    expect(hexPreview("AAECAwQFBgcICQoLDA0ODxAR", 18)).toBe("00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f … (18 bytes)");
    expect(hexPreview("AAEC", 2048)).toBe("00 01 02 … (2048 bytes)");
  });
});

describe("a key rebuilt from the whole row", () => {
  const whole = (values: Record<string, unknown>) => (name: string) => values[name] ?? null;
  it("keeps a key that arrived whole", () => {
    expect(wholeKey({ index: 1, value: "a" }, ["index", "value"], whole({ index: 1, value: "a" }))).toEqual({ index: 1, value: "a" });
  });
  it("takes the whole value when it starts with what the page showed", () => {
    expect(wholeKey({ index: 1, value: "LLL" }, ["index", "value"], whole({ index: 1, value: "LLLLLL" }))).toEqual({ index: 1, value: "LLLLLL" });
  });
  it("refuses when the row changed since the page was read", () => {
    expect(wholeKey({ index: 1, value: "LLL" }, ["index", "value"], whole({ index: 1, value: "zzz" }))).toBe("changed");
    expect(wholeKey({ index: 1, value: "LLL" }, ["index", "value"], whole({ index: 2, value: "LLLLLL" }))).toBe("changed");
    expect(wholeKey({ index: 1, value: 5 }, ["index", "value"], whole({ index: 1, value: 50 }))).toBe("changed");
  });
});
