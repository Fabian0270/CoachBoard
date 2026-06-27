import type { ExternalImportWarning } from 'coachboard-shared'

// ---------------------------------------------------------------------------
// Shared value normalisation (used by every layout parser) — recover ranges
// mangled into dates, convert RIR→RPE / fractions→%, strip units, map weekdays.
// ---------------------------------------------------------------------------

const BODYWEIGHT = /^bw$|^kv$|body\s*weight|kroppsvikt/i // EN "BW"/"bodyweight", SV "KV"/"kroppsvikt"

export function normalizeReps(text: string, sheetRow: number, warnings: ExternalImportWarning[]): string | null {
  let reps = text || null
  if (reps) {
    // Excel silently turns a rep RANGE like "4-8" or "6-10" into a date
    // (e.g. 2025-04-08). Recover the two numbers and order them low-high so the
    // higher rep is the top of the range (Excel's month/day order is arbitrary).
    const d = reps.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (d) {
      const [lo, hi] = [parseInt(d[2], 10), parseInt(d[3], 10)].sort((a, b) => a - b)
      reps = `${lo}-${hi}`
    }
    if (/amrap|as needed|max reps/i.test(reps)) {
      warnings.push({ sheetRow, message: `Row ${sheetRow}: variable reps "${reps}" kept as-is (no fixed value).` })
    }
  }
  return reps
}

/** Intensity/Weight free-text; a bare decimal fraction (|n|<1) is a % backoff. */
export function normalizeIntensity(text: string): string | null {
  if (!text) return null
  const norm = text.replace(',', '.')
  if (/^-?\d*\.\d+$/.test(norm)) {
    const n = parseFloat(norm)
    if (!isNaN(n) && n !== 0 && Math.abs(n) < 1) {
      return `${+(n * 100).toFixed(2)}%`
    }
  }
  return text
}

/** "Load Used" → number-ish string; bodyweight → null; strip kg/lbs; warn on junk. */
export function normalizeLoad(text: string, sheetRow: number, warnings: ExternalImportWarning[]): string | null {
  if (!text) return null
  if (BODYWEIGHT.test(text)) return null
  const m = text.replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*(kg|lbs|lb)?$/i)
  if (m) return m[1]
  warnings.push({ sheetRow, message: `Row ${sheetRow}: could not read load "${text}" — left blank.` })
  return null
}

/** "Load Cap" → number (best-effort, ignores trailing text); null if none. */
export function normalizeLoadCap(text: string): number | null {
  if (!text) return null
  const m = text.replace(',', '.').match(/^(\d+(?:\.\d+)?)/)
  return m ? parseFloat(m[1]) : null
}

export function normalizeRpe(text: string, fromRir: boolean, sheetRow: number, warnings: ExternalImportWarning[]): string | null {
  if (!text) return null
  const num = parseFloat(text.replace(',', '.'))
  if (isNaN(num)) {
    warnings.push({ sheetRow, message: `Row ${sheetRow}: could not read ${fromRir ? 'RIR' : 'RPE'} "${text}" — left blank.` })
    return null
  }
  return fromRir ? String(10 - num) : String(num)
}

// Prefix → 0..6 (Mon..Sun). English plus Swedish (Scandinavian coaching sheets
// label days "Tisdag"/"Torsdag"/…). ASCII fallbacks ('man','lor','son') cover
// files whose accented characters were stripped on a round-trip through Excel.
const WEEKDAY_PREFIXES: ReadonlyArray<readonly [string, number]> = [
  ['mon', 0], ['tue', 1], ['wed', 2], ['thu', 3], ['fri', 4], ['sat', 5], ['sun', 6],
  ['mån', 0], ['man', 0], ['tis', 1], ['ons', 2], ['tor', 3], ['fre', 4], ['lör', 5], ['lor', 5], ['sön', 6], ['son', 6],
]
/** Weekday name → 0..6 (Mon..Sun), or null. */
export function weekdayOffset(text: string): number | null {
  const t = text.trim().toLowerCase()
  for (const [prefix, idx] of WEEKDAY_PREFIXES) {
    if (t.startsWith(prefix)) return idx
  }
  return null
}
