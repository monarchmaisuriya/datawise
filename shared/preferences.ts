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

function oneOf<const T extends readonly number[]>(choices: T, fallback: T[number]) {
  return z.number().refine((value) => choices.includes(value)).default(fallback);
}

// Every default matches how Datawise behaved before settings existed, so an empty document changes nothing.
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
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = preferencesSchema.parse({});

export const preferencesDocument = defineSettings({ id: "preferences", scope: "host", version: 1, schema: preferencesSchema });
