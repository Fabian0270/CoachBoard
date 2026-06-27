import type ExcelJS from 'exceljs'

// ---------------------------------------------------------------------------
// Cell & text parsing — turn raw ExcelJS cell values into plain text/tokens and
// classify the basic shapes (numeric-like cells, week/day section headers).
// ---------------------------------------------------------------------------

/** Convert any ExcelJS cell value into trimmed plain text. */
export function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim()
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>
    if ('text' in v && typeof v.text === 'string') return v.text.trim()
    if ('result' in v && v.result !== undefined && v.result !== null) {
      // A formula whose cached result is itself a Date must format the same way
      // a top-level Date does (ISO yyyy-mm-dd) — String(Date) yields a locale
      // string like "Sat Aug 06 2022 …" that the date-range recovery can't read.
      return v.result instanceof Date
        ? v.result.toISOString().slice(0, 10)
        : String(v.result).trim()
    }
    if ('richText' in v && Array.isArray(v.richText)) {
      return v.richText.map((r: { text?: string }) => r.text ?? '').join('').trim()
    }
    // A formula / shared-formula cell with no cached result, or any other
    // object shape we can't read as text, carries no value — never stringify it
    // to "[object Object]" (that leaks into names, reps and load as junk).
    return ''
  }
  return String(value).trim()
}

// Keep Nordic letters (å ä ö) so Swedish headers like "Övning" / "Vikt" survive
// tokenisation — a plain [^a-z0-9] split would drop the diacritics and mangle them.
export const tokenize = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9åäö]+/).filter(Boolean)

const NUMERIC = /^\d+(\.\d+)?$/
export const RANGE = /^\d+(\.\d+)?\s*[-–—]\s*\d+(\.\d+)?$/

/** A sets/reps cell that looks like a number or a range ("3", "3-5", "3–5"). */
export function isNumericLike(text: string): boolean {
  const t = text.trim()
  return NUMERIC.test(t) || RANGE.test(t)
}

// Week/day section detection, English + Swedish.
export function classifySectionHeader(text: string): 'week' | 'day' | 'unknown' {
  const t = text.trim().toLowerCase()
  // "Week 3" / "Vecka 3" / "Block 2" / "Fas 1" / "Mesocykel 1" — needs a number.
  if (/^(week|vecka|block|phase|fas|meso\w*)\b/.test(t) && /\d/.test(t)) return 'week'
  if (/^[wv]\s*\d+/.test(t)) return 'week' // "W1" / "V1"
  // Day / session sections.
  if (/^(day|dag|session|pass|träningspass)\b/.test(t)) return 'day'
  if (/^(mon|tue|wed|thu|fri|sat|sun)/.test(t)) return 'day' // English weekdays
  if (/^(mån|tis|ons|tors|fre|lör|sön)/.test(t)) return 'day' // Swedish weekdays
  if (/^(upper|lower|push|pull|legs|full\s*body)\b/.test(t)) return 'day'
  if (/^(överkropp|underkropp|ben|helkropp|skjut|drag)\b/.test(t)) return 'day' // Swedish day-types
  return 'unknown'
}
