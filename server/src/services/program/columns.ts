import { parseExportLayout } from 'coachboard-shared/exportLayout'

// ---------------------------------------------------------------------------
// Column helpers — live here because they touch DB representation
// ---------------------------------------------------------------------------

const TOGGLEABLE_COLUMNS = ['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe'] as const
type ToggleableColumn = typeof TOGGLEABLE_COLUMNS[number]

export function serializeEnabledColumns(input: unknown): string | null {
  if (input === null || input === undefined) return null
  if (!Array.isArray(input)) return null
  const filtered = input.filter(
    (c): c is ToggleableColumn =>
      typeof c === 'string' && (TOGGLEABLE_COLUMNS as readonly string[]).includes(c),
  )
  return JSON.stringify(filtered)
}

// Turn the DB row's stringly-typed enabled_columns + export_layout into the
// parsed shapes the API contract (Program) promises.
export function withParsedColumns<T extends { enabled_columns: string | null; export_layout?: string | null }>(
  program: T,
) {
  const export_layout = parseExportLayout(program.export_layout ?? null)
  let enabled_columns: ToggleableColumn[] | null = null
  if (program.enabled_columns) {
    try {
      const parsed = JSON.parse(program.enabled_columns)
      if (Array.isArray(parsed)) {
        enabled_columns = parsed.filter((c): c is ToggleableColumn =>
          (TOGGLEABLE_COLUMNS as readonly string[]).includes(c),
        )
      }
    } catch { /* leave null */ }
  }
  return { ...program, enabled_columns, export_layout }
}
