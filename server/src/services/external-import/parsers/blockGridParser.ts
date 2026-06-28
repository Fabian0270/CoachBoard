import type {
  ExternalColumnMapping,
  ExternalExerciseRow,
  ExternalImportWarning,
} from 'coachboard-shared'
import { tokenize, RANGE } from '../cellParsing.js'
import { DAY_LABEL } from '../layoutDetection.js'
import { normalizeReps, normalizeIntensity, normalizeLoad } from '../valueNormalizers.js'
import { emptyMapping, type ParseResult, type ReadRow } from '../shared.js'

// ---------------------------------------------------------------------------
// Block-grid layout (Feature 4c). Like the horizontal
// layout, weeks are side-by-side column blocks; but it differs in three ways
// the horizontal parser cannot absorb:
//   1. each "Week N" banner sits one column RIGHT of its block (the block's
//      first column holds a "DAY 1" label instead);
//   2. days are "DAY 1".."DAY 7" SECTION ROWS inside each block's first column
//      (not weekday names in column 1), and the Movement/Sets/… header row
//      repeats under every day;
//   3. RPE is written "@6" / "@6-7", with the odd "-0.05" load-backoff fraction
//      landing in the RPE column, plus a separate executed-RPE ("eRPE") column.
// ---------------------------------------------------------------------------

export interface GridFields {
  name: number | null   // offsets relative to a block's start column
  sets: number | null
  reps: number | null
  load: number | null
  rpe: number | null
  erpe: number | null   // executed RPE — ignored on import, but tracked so the
                        // re-fill engine can clear stale executed values
  rpeFromRir: boolean
}

export function resolveGridFields(headerCells: string[], blockStart: number, blockWidth: number): GridFields {
  const f: GridFields = { name: null, sets: null, reps: null, load: null, rpe: null, erpe: null, rpeFromRir: false }
  for (let off = 0; off < blockWidth; off++) {
    const toks = tokenize(headerCells[blockStart - 1 + off] ?? '')
    if (toks.length === 0) continue
    const has = (...words: string[]) => toks.some((t) => words.includes(t))
    // "eRPE" (executed) tokenises to ["erpe"] and is NOT used as the prescribed
    // RPE — we keep the plain "RPE" column — but its position is recorded for the
    // re-fill engine. Order: name, then specific RPE before the generic
    // set/rep/load so a stray token never steals a numeric column.
    if (f.name === null && has('movement', 'exercise', 'lift', 'name', 'discipline')) f.name = off
    else if (toks.includes('erpe')) { if (f.erpe === null) f.erpe = off; continue }
    else if (f.rpe === null && has('rpe', 'effort', 'rir')) { f.rpe = off; f.rpeFromRir = toks.includes('rir') }
    else if (f.reps === null && has('reps', 'rep', 'repetitions')) f.reps = off
    else if (f.sets === null && has('sets', 'set')) f.sets = off
    else if (f.load === null && has('load', 'weight', 'kg', 'lbs', 'lb', 'intensity')) f.load = off
  }
  return f
}

/**
 * RPE in this style is "@6" / "@6-7". A bare negative fraction ("-0.05") is a
 * load backoff the coach typed in the RPE column → routed to intensity instead.
 */
export function normalizeBlockRpe(
  text: string, fromRir: boolean, sheetRow: number, warnings: ExternalImportWarning[],
): { rpe: string | null; intensity: string | null } {
  if (!text) return { rpe: null, intensity: null }
  const asPct = normalizeIntensity(text)
  if (asPct && asPct.endsWith('%')) return { rpe: null, intensity: asPct }
  let t = text.trim()
  if (t.startsWith('@')) t = t.slice(1).trim()
  if (!t) return { rpe: null, intensity: null }
  if (RANGE.test(t)) return { rpe: t.replace(/\s*[–—]\s*/g, '-'), intensity: null }
  const num = parseFloat(t.replace(',', '.'))
  if (isNaN(num)) {
    warnings.push({ sheetRow, message: `Row ${sheetRow}: could not read ${fromRir ? 'RIR' : 'RPE'} "${text}" — left blank.` })
    return { rpe: null, intensity: null }
  }
  return { rpe: fromRir ? String(10 - num) : String(num), intensity: null }
}

export function parseBlockGrid(
  readRow: ReadRow,
  maxRow: number,
  banner: { row: number; weekCols: number[] },
  blockStarts: number[],
): ParseResult {
  const warnings: ExternalImportWarning[] = []
  const errors: string[] = []

  const blockWidth = blockStarts.length >= 2 ? blockStarts[1] - blockStarts[0] : 8

  // Header row = first row at/after the banner whose first block carries the
  // Movement/Sets/Reps labels (these repeat under every day in this layout).
  let headerRow = 0
  const limit = Math.min(maxRow, banner.row + 8)
  for (let r = banner.row; r <= limit; r++) {
    const b0 = readRow(r).slice(blockStarts[0] - 1, blockStarts[0] - 1 + blockWidth).join(' ').toLowerCase()
    if (/\bset/.test(b0) && /\brep/.test(b0)) { headerRow = r; break }
  }
  if (!headerRow) {
    errors.push('Could not find the Movement/Sets/Reps column headers under the week blocks.')
    return { columnMapping: emptyMapping(), weeks: 0, days: 0, exerciseCount: 0, exercises: [], warnings, errors }
  }

  const fields = resolveGridFields(readRow(headerRow), blockStarts[0], blockWidth)
  const missing: string[] = []
  if (fields.name === null) missing.push('Movement')
  if (fields.sets === null) missing.push('Sets')
  if (fields.reps === null) missing.push('Reps')
  if (missing.length > 0) {
    errors.push(`Required column(s) not found: ${missing.join(', ')}. The file cannot be imported.`)
    return { columnMapping: emptyMapping(), weeks: 0, days: 0, exerciseCount: 0, exercises: [], warnings, errors }
  }
  if (fields.load === null) {
    warnings.push({ message: 'No Load column found — the program will have no load data.' })
  }
  if (fields.rpe === null) {
    warnings.push({ message: 'No RPE column found — no effort analysis will be available for this program.' })
  }

  // The banner row carries the first "DAY n" label in each block's lead column.
  const bannerCells = readRow(banner.row)
  const firstDay = bannerCells[blockStarts[0] - 1]?.trim() ?? ''
  const firstDayMatch = firstDay.match(DAY_LABEL)
  let dayIndex = firstDayMatch ? parseInt(firstDayMatch[1], 10) - 1 : 0
  let dayLabel = firstDayMatch ? firstDay : 'Day 1'

  const exercises: ExternalExerciseRow[] = []
  const blockName: string[] = new Array(blockStarts.length).fill('') // per-block name carry-forward

  for (let r = headerRow + 1; r <= maxRow; r++) {
    const cells = readRow(r)

    // A "DAY n" label in the first block's lead column starts a new day section.
    const lead = (cells[blockStarts[0] - 1] ?? '').trim()
    const dayMatch = lead.match(DAY_LABEL)
    if (dayMatch) {
      dayIndex = parseInt(dayMatch[1], 10) - 1
      dayLabel = lead
      blockName.fill('')
      continue
    }

    // Skip the Movement/Sets/Reps header row that repeats under each day.
    const blk0 = cells.slice(blockStarts[0] - 1, blockStarts[0] - 1 + blockWidth).join(' ').toLowerCase()
    if (/\bsets?\b/.test(blk0) && /\breps?\b/.test(blk0)) continue

    for (let w = 0; w < blockStarts.length; w++) {
      const base = blockStarts[w]
      const get = (off: number | null) => (off === null ? '' : (cells[base - 1 + off] ?? ''))

      let name = get(fields.name)
      if (name) blockName[w] = name
      else name = blockName[w]

      const setsText = get(fields.sets)
      const repsText = get(fields.reps)
      const loadText = get(fields.load)
      const rpeText = get(fields.rpe)

      const hasData = !!(setsText || repsText || loadText || rpeText)
      if (!name || !hasData) continue

      const { rpe, intensity } = normalizeBlockRpe(rpeText, fields.rpeFromRir, r, warnings)
      exercises.push({
        weekIndex: w,
        dayIndex,
        weekLabel: `Week ${w + 1}`,
        dayLabel: dayLabel || `Day ${dayIndex + 1}`,
        name,
        sets: setsText || null,
        reps: normalizeReps(repsText, r, warnings),
        load: normalizeLoad(loadText, r, warnings),
        rpe,
        sheetRow: r,
        intensity,
        refillCols: {
          name: fields.name !== null ? base + fields.name : null,
          sets: fields.sets !== null ? base + fields.sets : null,
          reps: fields.reps !== null ? base + fields.reps : null,
          load: fields.load !== null ? base + fields.load : null,
          rpe: fields.rpe !== null ? base + fields.rpe : null,
          erpe: fields.erpe !== null ? base + fields.erpe : null,
        },
      })
    }
  }

  const b0 = blockStarts[0]
  const mapping: ExternalColumnMapping = {
    exercise: fields.name !== null ? b0 + fields.name : null,
    sets: fields.sets !== null ? b0 + fields.sets : null,
    reps: fields.reps !== null ? b0 + fields.reps : null,
    load: fields.load !== null ? b0 + fields.load : null,
    rpe: fields.rpe !== null ? b0 + fields.rpe : null,
    rpeFromRir: fields.rpeFromRir,
  }

  if (exercises.length === 0) {
    warnings.push({ message: 'No exercise rows were detected under the week blocks.' })
  }

  return {
    headerRow,
    columnMapping: mapping,
    weeks: new Set(exercises.map((e) => e.weekIndex)).size,
    days: new Set(exercises.map((e) => `${e.weekIndex}-${e.dayIndex}`)).size,
    exerciseCount: exercises.length,
    exercises,
    warnings,
    errors,
  }
}
