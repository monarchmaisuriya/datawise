import type { RowKey } from "./contracts";

// A key value can arrive cut only on Redis, where a list entry's value checks that the entry has not moved.
// The key is rebuilt from the whole row, read again when the row opened, and only if each whole value starts
// with what the page showed. Otherwise the row changed since the page was read, and nothing may be written.
export function wholeKey(shown: RowKey, keyColumns: readonly string[], wholeValueOf: (name: string) => unknown): RowKey | "changed" {
  const rebuilt: RowKey = {};
  for (const name of keyColumns) {
    const before = shown[name];
    const now = wholeValueOf(name);
    if (before === now || (typeof before === "string" && typeof now === "string" && now.startsWith(before))) rebuilt[name] = now;
    else return "changed";
  }
  return rebuilt;
}
