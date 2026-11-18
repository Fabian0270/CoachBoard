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
export function normalizeLoad(
  text: string,
  sheetRow: number,
  warnings: ExternalImportWarning[],
  /** A coach's prescription keeps text it cannot reduce to a number ("75%", "140-145"); a result does not. */
  keepText = false,
): string | null {
  if (!text) return null
  if (BODYWEIGHT.test(text)) return null
  const m = text.replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*(kg|lbs|lb)?$/i)
  if (m) {
    // Stored as the number, as before — but a pound figure is not a kilogram
    // one, and taking it silently meant every load and e1RM read 2.2x heavy.
    if (m[2] && m[2].toLowerCase().startsWith('lb')) {
      warnings.push({
        sheetRow,
        message: `Row ${sheetRow}: load "${text}" says pounds — stored as ${m[1]}. Set the athlete to lb (on their page) if their sheet is in pounds.`,
      })
    }
    return m[1]
  }
  if (keepText) return text.trim() || null
  warnings.push({ sheetRow, message: `Row ${sheetRow}: could not read load "${text}" — left blank.` })
  return null
}

/** "Load Cap" → number (best-effort, ignores trailing text); null if none. */
export function normalizeLoadCap(text: string): number | null {
  if (!text) return null
  const m = text.replace(',', '.').match(/^(\d+(?:\.\d+)?)/)
  return m ? parseFloat(m[1]) : null
}

/**
 * RPE (or RIR) as written in a sheet: "8", "@8", "8,5", "8-9", "@7–8".
 *
 * "@8" — the notation the app's own exporter writes for coaches who use it —
 * used to be unreadable here and left blank; "8-9" was parseFloat'd to 8, so a
 * range quietly became its bottom end. A range is kept as a range, the same
 * way the block-grid parser already did.
 */
export function normalizeRpe(text: string, fromRir: boolean, sheetRow: number, warnings: ExternalImportWarning[]): string | null {
  if (!text) return null
  let t = text.trim()
  if (t.startsWith('@')) t = t.slice(1).trim()
  t = t.replace(/,/g, '.')
  const toRpe = (n: number) => String(fromRir ? 10 - n : n)

  const range = t.match(/^(\d+(?:\.\d+)?)\s*[-–—]\s*(\d+(?:\.\d+)?)$/)
  if (range) {
    const [a, b] = [parseFloat(range[1]), parseFloat(range[2])].map((n) => Number(toRpe(n)))
    return `${Math.min(a, b)}-${Math.max(a, b)}`
  }
  if (!/^\d+(?:\.\d+)?$/.test(t)) {
    warnings.push({ sheetRow, message: `Row ${sheetRow}: could not read ${fromRir ? 'RIR' : 'RPE'} "${text}" — left blank.` })
    return null
  }
  return toRpe(parseFloat(t))
}

/**
 * A Sets cell, recovering the shapes Excel and coaches give it.
 *
 * Excel turns a range like "3-4" into a date (2026-03-04), exactly as it does
 * to reps; this undoes that, and leaves anything else as written.
 */
export function normalizeSets(text: string): string {
  const d = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (d) {
    const [lo, hi] = [parseInt(d[2], 10), parseInt(d[3], 10)].sort((a, b) => a - b)
    return `${lo}-${hi}`
  }
  return text
}

// Prefix → 0..6 (Mon..Sun). English plus Swedish (Scandinavian coaching sheets
// label days "Tisdag"/"Torsdag"/…). ASCII fallbacks ('man','lor','son') cover
// files whose accented characters were stripped on a round-trip through Excel.
const WEEKDAY_PREFIXES: ReadonlyArray<readonly [string, number]> = [
  ['mon', 0], ['tue', 1], ['wed', 2], ['thu', 3], ['fri', 4], ['sat', 5], ['sun', 6],
  ['mån', 0], ['man', 0], ['tis', 1], ['ons', 2], ['tor', 3], ['fre', 4], ['lör', 5], ['lor', 5], ['sön', 6], ['son', 6],
]
/**
 * Whether a cell IS a weekday label — the whole text, not just its start.
 *
 * weekdayOffset matches on a prefix, which is right for reading a label once
 * you know it is one, and wrong for deciding whether it is one: "French Press"
 * starts with "fre" (Fredag), "Man Maker" with "man", "Monster Walk" with
 * "mon". Used as a day header test, those turned an exercise into a new day and
 * re-filed every row after it.
 */
const WEEKDAY_WORD = new RegExp(
  '^(' +
    [
      'mon(day)?', 'tue(s(day)?)?', 'wed(nesday)?', 'thu(r(s(day)?)?)?', 'fri(day)?', 'sat(urday)?', 'sun(day)?',
      'm[åa]n(dag)?', 'tis(dag)?', 'ons(dag)?', 'tors?(dag)?', 'fre(dag)?', 'l[öo]r(dag)?', 's[öo]n(dag)?',
    ].join('|') +
    ')[.:]?$',
  'i',
)

export function isWeekdayLabel(text: string): boolean {
  return WEEKDAY_WORD.test(text.trim())
}

/**
 * A week banner: "Week 3", "W3", "Wk 3", "Vecka 3", "V3", and the same with a
 * suffix ("Week 3 – Volume"). Only the exact "Week N" form used to count, so a
 * Swedish or annotated sheet was handed to the stacked-rows parser, which read
 * 2 of its 6 exercises and 1 of its 3 weeks.
 */
export const WEEK_BANNER = /^(week|wk|w|vecka|v)\s*\.?\s*\d+(\s*[-–—:(].*)?$/i

/** Weekday name → 0..6 (Mon..Sun), or null. */
export function weekdayOffset(text: string): number | null {
  const t = text.trim().toLowerCase()
  for (const [prefix, idx] of WEEKDAY_PREFIXES) {
    if (t.startsWith(prefix)) return idx
  }
  return null
}
