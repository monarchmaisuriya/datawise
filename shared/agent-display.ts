import { BYTES_TAG } from "./contracts";

// Characters that draw as nothing or look like something else: control, format, bidirectional, zero-width,
// unusual spaces, variation selectors and tag characters.
const HIDDEN = new RegExp("[\\u0000-\\u001f\\u007f-\\u00a0\\u00ad\\u034f\\u061c\\u115f\\u1160\\u1680\\u17b4\\u17b5\\u180b-\\u180e\\u2000-\\u200f\\u2028-\\u202f\\u205f-\\u206f\\u3000\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff0-\\uffff\\u{e0000}-\\u{e0fff}]", "gu");

// For text that is a name, such as a column or an agent's title.
export function visibleText(text: string): string {
  return text.replace(HIDDEN, (character) => `\\u{${(character.codePointAt(0) ?? 0).toString(16)}}`);
}

// How a value is drawn on the approval screen. Text is always quoted, so null and "NULL", 1 and "1", and
// trailing spaces all look different, and a value cannot look like another change.
export function visibleValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object" && BYTES_TAG in value) {
    const encoded = String(Reflect.get(value, BYTES_TAG));
    return `<${Math.floor((encoded.length * 3) / 4)} bytes, starting ${encoded.slice(0, 16)}>`;
  }
  return visibleText(JSON.stringify(value));
}
