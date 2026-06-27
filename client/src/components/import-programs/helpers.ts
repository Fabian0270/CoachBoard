import type { ExternalParseOverrides } from 'coachboard-shared'
import type { Entry } from './types'

export const inputClass = 'w-full rounded border bg-background px-2 py-1.5 text-sm'

/** 1-based column index → spreadsheet letter (1 → A, 27 → AA). */
export function colLetter(n: number): string {
  let s = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    s = String.fromCharCode(65 + rem) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** Local YYYY-MM-DD for an <input type="date"> default. */
export function todayIso(): string {
  const d = new Date()
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10)
}

// A file is importable if it parsed, has no fatal errors, and has exercises.
export function isImportable(e: Entry): boolean {
  return !e.error && !!e.preview && e.preview.errors.length === 0 && e.preview.exerciseCount > 0
}

// Build the override query params sent on re-parse and commit (matches the
// server's externalOverridesFromQuery). Absent fields fall back to auto-detection.
export function overrideParams(o: ExternalParseOverrides): URLSearchParams {
  const p = new URLSearchParams()
  if (o.headerRow !== undefined) p.set('header_row', String(o.headerRow))
  const col = (key: string, v: number | null | undefined) => {
    if (v === undefined) return
    p.set(key, v === null ? 'none' : String(v))
  }
  col('map_exercise', o.exercise)
  col('map_sets', o.sets)
  col('map_reps', o.reps)
  col('map_load', o.load)
  col('map_rpe', o.rpe)
  if (o.rpeFromRir !== undefined) p.set('rpe_is_rir', o.rpeFromRir ? '1' : '0')
  return p
}

export const MAP_FIELDS: { key: 'exercise' | 'sets' | 'reps' | 'load' | 'rpe'; label: string; required?: boolean }[] = [
  { key: 'exercise', label: 'Exercise', required: true },
  { key: 'sets', label: 'Sets', required: true },
  { key: 'reps', label: 'Reps', required: true },
  { key: 'load', label: 'Load' },
  { key: 'rpe', label: 'RPE / RIR' },
]
