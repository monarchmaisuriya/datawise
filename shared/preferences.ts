import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { safetyMode } from "./contracts";

// Choices are fixed lists because a Select shows nothing useful for a value outside its options.
export const PAGE_SIZES = [50, 100, 500, 1000] as const;
export const QUERY_LIMITS = [100, 1000, 10000, 100000] as const;
export const TIME_LIMITS_MS = [30000, 60000, 300000, 1800000] as const;
export const HISTORY_LENGTHS = [0, 50, 200, 1000] as const;
export const IDLE_MINUTES = [5, 10, 30, 120] as const;
export const EXPORT_FORMATS = ["csv", "tsv", "json", "ndjson", "sql"] as const;
export const PREVIEW_LENGTHS = [256, 1024, 4096, 16384] as const;
export const TEXT_SIZES = { small: 11, medium: 12, large: 14 } as const;

function oneOf<const T extends readonly number[]>(choices: T, fallback: T[number]) {
  return z.number().refine((value) => choices.includes(value)).default(fallback);
}

// Every default matches how Datawise behaved before settings existed, so an empty document changes nothing.
// Two exceptions since 0.5.0, because both did work nobody asked for: data is no longer read again on return
// to Paseo, and the grid receives a preview of each value rather than up to 16 KiB.
export const preferencesSchema = z.object({
  rowsPerPage: oneOf(PAGE_SIZES, 100),
  queryRowLimit: oneOf(QUERY_LIMITS, 1000),
  queryTimeLimitMs: oneOf(TIME_LIMITS_MS, 60000),
  // Only the new-connection form reads this. A stored connection missing its mode stays Ask first.
  newConnectionSafety: safetyMode.default("confirm"),
  density: z.enum(["comfortable", "compact"]).default("comfortable"),
  nullText: z.string().max(12).default("NULL"),
  keepHistory: z.boolean().default(true),
  historyLength: oneOf(HISTORY_LENGTHS, 200),
  keepDrafts: z.boolean().default(true),
  exportFolder: z.string().max(500).default(""),
  exportFormat: z.enum(EXPORT_FORMATS).default("csv"),
  idleCloseMinutes: oneOf(IDLE_MINUTES, 10),
  // Web and desktop only: phones never report returning to the app.
  rereadOnReturn: z.boolean().default(false),
  // Characters of each value the grid receives. A key is always whole, and opening a row reads all of it.
  cellPreviewChars: oneOf(PREVIEW_LENGTHS, 1024),
  textSize: z.enum(["small", "medium", "large"]).default("medium"),
  groupDigits: z.boolean().default(false),
  binaryDisplay: z.enum(["size", "hex"]).default("size"),
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = preferencesSchema.parse({});

export const preferencesDocument = defineSettings({ id: "preferences", scope: "host", version: 1, schema: preferencesSchema });
