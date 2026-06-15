/**
 * Layout constants shared between the Excel exporter and importer.
 * Both sides import from here so they cannot drift apart.
 */

export const DAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
] as const

export type DayName = typeof DAY_NAMES[number]

/** Marker placed in the fixed column on the first exercise row of each day section */
export const NOTES_MARKER = 'notes:'

/** Column header labels written into each day's header row */
export const COLUMN_LABELS = {
  name: 'Discipline',
  rest_time: 'Rest Time (mins)',
  sets: 'Sets',
  reps: 'Reps',
  intensity: 'Intensity/Weight',
  load_cap: 'Load Cap',
  load_used: 'Load Used',
  rpe: 'Last Set RPE',
} as const

export type ExportColumnKey = keyof typeof COLUMN_LABELS

/** Number of fixed worksheet columns at the left edge (the "Day Name" column) */
export const FIXED_COLUMN_COUNT = 1

/**
 * Canonical order of all possible export columns.
 * Mirrors the exporter's exportColumns.push() sequence exactly.
 */
export const FULL_COLUMN_ORDER: ExportColumnKey[] = [
  'name',
  'rest_time',
  'sets',
  'reps',
  'intensity',
  'load_cap',
  'load_used',
  'rpe',
]

const ALWAYS_ON = new Set<ExportColumnKey>(['name', 'sets', 'reps'])

/**
 * Build the ordered list of export column keys for a given enabled-columns set.
 * Always includes name, sets, reps. Conditionally includes the rest.
 * Mirrors the exporter's column selection logic exactly.
 */
export function buildExportColumnKeys(enabledColumns: string[]): ExportColumnKey[] {
  const enabled = new Set(enabledColumns)
  return FULL_COLUMN_ORDER.filter((key) => ALWAYS_ON.has(key) || enabled.has(key))
}

/**
 * 1-indexed worksheet column number where a given week's data block starts.
 * weekIndex is 0-based. Matches the exporter's weekColumnStart formula.
 */
export function weekColumnStart(weekIndex: number, exportColumnCount: number): number {
  return FIXED_COLUMN_COUNT + 1 + weekIndex * (exportColumnCount + 1)
}
