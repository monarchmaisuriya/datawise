// Saved widths come from a file a person or an older version may have changed, so they are clamped, never refused.
export const COLUMN_WIDTH = { min: 60, max: 800 } as const;

export function clampWidth(width: number): number {
  return Math.round(Math.min(COLUMN_WIDTH.max, Math.max(COLUMN_WIDTH.min, width)));
}
