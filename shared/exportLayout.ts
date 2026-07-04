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

// ---------------------------------------------------------------------------
// Export layout template — the captured "fingerprint" of a coach's own Excel
// layout, so programs derived from an import re-export in the coach's style
// rather than CoachBoard's generic look. Captured at import time (from the
// uploaded file's structure + cell styling) and replayed by the exporter.
//
// NOTE: kept dependency-free on purpose (no import from ./types.js) so types.ts
// can import this without a cycle. `ExportOrientation` mirrors the importer's
// `ExternalLayout` union by value.
// ---------------------------------------------------------------------------

export type ExportOrientation = 'horizontal' | 'vertical' | 'block-grid' | 'week-grid'

/** How a coach labels the day sections of their sheet. */
export type DayLabelStyle =
  | 'weekday'  // Monday, Tuesday … (or Swedish: Måndag, Tisdag …)
  | 'dayN'     // Day 1, Day 2 … / DAY 1 …
  | 'split'    // Upper, Lower, Push … (free-text section names)

/** How RPE is written in the load/effort cells. */
export type RpeNotation = 'plain' | 'at'   // "8"  vs  "@8"

export interface ExportLayoutColumn {
  key: ExportColumnKey
  label: string   // the coach's own header wording (e.g. "Movement" vs "Discipline")
}

/** ARGB fill strings (ExcelJS form, e.g. "FFB39DDB"); null = use the default. */
export interface ExportLayoutColors {
  weekBanner?: string | null
  dayHeader?: string | null
  columnHeader?: string | null   // header cells for name/sets/reps/… (non-tracking)
  trackingHeader?: string | null // header cells for load_used/rpe/load_cap (tracking)
  body?: string | null
}

export interface ExportLayoutFonts {
  headerBold?: boolean
  headerItalic?: boolean
  nameBold?: boolean   // bold the exercise-name cell on its first row
}

export interface ExportLayoutTemplate {
  version: 1
  orientation: ExportOrientation
  columns: ExportLayoutColumn[]
  dayLabels: {
    style: DayLabelStyle
    language: 'en' | 'sv'
    // Explicit per-day-index labels captured from the source, when present
    // (e.g. ['Tisdag', 'Torsdag', …]). Index 0 = Monday. Falls back to
    // `style` + `language` defaults for any index without a captured label.
    custom?: (string | null)[]
  }
  rpeNotation: RpeNotation
  colors: ExportLayoutColors
  fonts: ExportLayoutFonts
}

/** Weekday names by language, index 0 = Monday. Used to render `dayLabels`. */
export const WEEKDAY_NAMES: Record<'en' | 'sv', string[]> = {
  en: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  sv: ['Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lördag', 'Söndag'],
}

/** Resolve the label for a given 0-based day index from a template's dayLabels. */
export function dayLabelFor(
  dayLabels: ExportLayoutTemplate['dayLabels'],
  dayIndex: number,
): string {
  const custom = dayLabels.custom?.[dayIndex]
  if (custom) return custom
  if (dayLabels.style === 'dayN') return `Day ${dayIndex + 1}`
  // 'weekday' (and 'split' with no captured custom label) fall back to weekday names
  return WEEKDAY_NAMES[dayLabels.language][dayIndex] ?? `Day ${dayIndex + 1}`
}

/** Parse a stored export_layout JSON string into a template, or null if absent/invalid. */
export function parseExportLayout(raw: string | null | undefined): ExportLayoutTemplate | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as ExportLayoutTemplate
    if (parsed && parsed.version === 1 && parsed.orientation && Array.isArray(parsed.columns)) {
      return parsed
    }
  } catch { /* fall through */ }
  return null
}

// ---------------------------------------------------------------------------
// Built-in starter templates — the three looks a coach can pick from on the New
// Program page and in the Generate-program wizard (for programs that don't reuse
// an imported coach style). The choice is stored on the program as
// `builtin_template`; the exporter routes the render off it.
//   • coachboard — the classic CoachBoard look (the existing default renderer).
//   • minimal    — a monochrome, essentials-only descriptor (the descriptor path).
//   • modern      — a card-style layout with an e1RM reference badge (own renderer).
// ---------------------------------------------------------------------------

export const BUILTIN_EXPORT_TEMPLATES = [
  {
    id: 'coachboard',
    name: 'CoachBoard',
    description:
      'The classic CoachBoard look — colour-coded week blocks with every tracking column.',
  },
  {
    id: 'minimal',
    name: 'Minimalistic',
    description:
      'Clean monochrome layout with just the essentials: exercise, sets, reps, load, RPE.',
  },
  {
    id: 'modern',
    name: 'Modern',
    description:
      'Card-style layout that highlights each lift and shows the athlete’s current e1RM.',
  },
] as const

export type BuiltinTemplateId = typeof BUILTIN_EXPORT_TEMPLATES[number]['id']

export const BUILTIN_TEMPLATE_IDS = BUILTIN_EXPORT_TEMPLATES.map((t) => t.id) as BuiltinTemplateId[]

export const DEFAULT_BUILTIN_TEMPLATE: BuiltinTemplateId = 'coachboard'

export function isBuiltinTemplateId(value: unknown): value is BuiltinTemplateId {
  return typeof value === 'string' && BUILTIN_EXPORT_TEMPLATES.some((t) => t.id === value)
}

/**
 * The "Minimalistic" built-in as an ExportLayoutTemplate descriptor — replayed by
 * the existing descriptor renderer. Dark-grey banners/day-headers (white text) with
 * light column headers and no body fill give a clean monochrome look; the column set
 * is trimmed to the essentials. Exercise names are not bolded.
 */
export const MINIMAL_DESCRIPTOR: ExportLayoutTemplate = {
  version: 1,
  orientation: 'horizontal',
  columns: [
    { key: 'name', label: 'Exercise' },
    { key: 'sets', label: 'Sets' },
    { key: 'reps', label: 'Reps' },
    { key: 'load_used', label: 'Load' },
    { key: 'rpe', label: 'RPE' },
  ],
  dayLabels: { style: 'weekday', language: 'en' },
  rpeNotation: 'plain',
  colors: {
    weekBanner: 'FF555555',
    dayHeader: 'FF555555',
    columnHeader: 'FFF0F0F0',
    trackingHeader: 'FFF0F0F0',
    body: null,
  },
  fonts: { headerBold: true, headerItalic: false, nameBold: false },
}
