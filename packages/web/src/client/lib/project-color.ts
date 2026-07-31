// Deterministic project accent color, with a preset palette matching the
// --chart-1..5 categorical colors defined in index.css.

export const PROJECT_COLOR_PRESETS: readonly string[] = [
  '#58c4dd',
  '#e8a852',
  '#58ea8a',
  '#c8c5cb',
  '#ffb4ab',
];

/**
 * Returns `specColor` if set, otherwise a deterministic color derived from
 * `name` (e.g. `metadata.name`) via a cheap hash into `PROJECT_COLOR_PRESETS`.
 */
export function projectColor(name: string, specColor?: string | null): string {
  if (specColor) return specColor;

  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash += name.charCodeAt(i);
  }
  // Modulo guarantees an in-bounds index into a non-empty array.
  return PROJECT_COLOR_PRESETS[hash % PROJECT_COLOR_PRESETS.length] as string;
}
