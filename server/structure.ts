import type { ObjectDetails } from "../shared/contracts";

// Text a person or an agent can be given about a table: names and types, and nothing else. Built field by
// field, so a new field on ObjectDetails stays out until someone decides otherwise. That leaves out
// defaults, definitions and facts, any of which can hold values from the data.
export function safeType(type: string | null): string {
  if (!type) return "unknown";
  // enum('active','banned') lists real values. varchar(255) does not.
  return type.includes("'") ? type.replace(/\(.*\)/s, "") : type;
}

export interface Structure {
  name: string;
  kind: string;
  columns: { name: string; type: string; nullable: boolean | null; key: boolean }[];
  foreignKeys: { columns: string[]; targetTable: string | null; targetColumns: string[] }[];
}

export function structureOf(details: ObjectDetails): Structure {
  return {
    name: details.name,
    kind: details.kind,
    columns: details.columns.map((column) => ({ name: column.name, type: safeType(column.type), nullable: column.nullable, key: column.isKey })),
    foreignKeys: details.foreignKeys.map((key) => ({ columns: key.columns, targetTable: key.targetTable, targetColumns: key.targetColumns })),
  };
}

export function structureText(structure: Structure): string {
  const lines = [`${structure.kind} ${structure.name}`];
  for (const column of structure.columns) lines.push(`- ${column.name}: ${column.type}${column.nullable === false ? " not null" : ""}${column.key ? " key" : ""}`);
  for (const key of structure.foreignKeys) {
    if (key.targetTable) lines.push(`- foreign key ${key.columns.join(", ")} references ${key.targetTable} (${key.targetColumns.join(", ")})`);
  }
  return lines.join("\n");
}
