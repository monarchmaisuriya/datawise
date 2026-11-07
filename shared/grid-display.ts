import { BYTES_TAG, bytesSize } from "./contracts";

// Columns are drawn only near the part of the grid in view. Widths are in display order; from and to are
// pixel offsets from the first column. Returns the first and last column to draw, inclusive.
export function columnRange(widths: readonly number[], from: number, to: number): { first: number; last: number } {
  let start = 0;
  let first = -1;
  let last = -1;
  for (const [index, width] of widths.entries()) {
    const end = start + width;
    if (first === -1 && end > from) first = index;
    if (start < to) last = index;
    start = end;
  }
  if (first === -1) return { first: Math.max(0, widths.length - 1), last: widths.length - 1 };
  return { first, last: Math.max(first, last) };
}

// Digit groups for display only. Text that looks like a number is never touched, and neither are keys.
export function groupDigits(value: number): string {
  const text = String(value);
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(text);
  if (!match) return text;
  return `${match[1]}${(match[2] as string).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${match[3] ?? ""}`;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// The first bytes of a base64 value, as hex. Decoded here because atob is not on every React Native engine.
export function hexPreview(base64: string, size: number, count = 16): string {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of base64) {
    const value = BASE64.indexOf(char);
    if (value === -1) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      if (bytes.length === count) break;
    }
  }
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
  return size > bytes.length ? `${hex} … (${size} bytes)` : hex;
}

export function bytesOf(cell: unknown): { base64: string; size: number } | null {
  if (cell === null || typeof cell !== "object" || !(BYTES_TAG in cell)) return null;
  const base64 = Reflect.get(cell, BYTES_TAG);
  return typeof base64 === "string" ? { base64, size: bytesSize(cell) } : null;
}
