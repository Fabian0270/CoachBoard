import type {
  ExternalColumnMapping,
  ExternalExerciseRow,
  ExternalImportWarning,
} from 'coachboard-shared'
import { tokenize } from '../cellParsing.js'
import { ALIASES } from '../headerDetection.js'
import {
  normalizeReps,
  normalizeIntensity,
  normalizeLoad,
  normalizeLoadCap,
  normalizeRpe,
  weekdayOffset,
} from '../valueNormalizers.js'
import { emptyMapping, type ParseResult, type ReadRow } from '../shared.js'

// ---------------------------------------------------------------------------
// Horizontal layout — weeks are side-by-side column blocks (CoachBoard's own
// export shape and common powerlifting sheets). Inverts the exporter geometry.
// ---------------------------------------------------------------------------
interface BlockFields {
  name: number | null     // offsets relative to a week-block's start column
  restTime: number | null
  sets: number | null
  reps: number | null
  intensity: number | null
  loadCap: number | null
  loadUsed: number | null
  rpe: number | null
  rpeFromRir: boolean
}

function resolveBlockFields(headerCells: string[], blockStart: number, blockWidth: number): BlockFields {
  const f: BlockFields = {
    name: null, restTime: null, sets: null, reps: null,
    intensity: null, loadCap: null, loadUsed: null, rpe: null, rpeFromRir: false,
  }
  for (let off = 0; off < blockWidth; off++) {
    const toks = tokenize(headerCells[blockStart - 1 + off] ?? '')
    if (toks.length === 0) continue
    const has = (...words: string[]) => toks.some((t) => words.includes(t))
    // Order matters: specific tokens (used/cap/intensity/rpe) resolve before the
    // generic set/rep so the duplicated load columns don't collide.
    if (f.name === null && has('discipline', 'exercise', 'movement', 'lift', 'name')) f.name = off
    else if (f.rpe === null && has('rpe', 'effort', 'rir')) { f.rpe = off; f.rpeFromRir = toks.includes('rir') }
    else if (f.loadUsed === null && has('used')) f.loadUsed = off
    else if (f.loadCap === null && has('cap')) f.loadCap = off
    else if (f.intensity === null && has('intensity')) f.intensity = off
    else if (f.restTime === null && has('rest')) f.restTime = off
    else if (f.reps === null && has('reps', 'rep', 'repetitions')) f.reps = off
    else if (f.sets === null && has('sets', 'set')) f.sets = off
  }
  return f
}

/** Rightmost name (Discipline/Exercise/…) header to the left of the first block. */
function findSharedNameCol(headerCells: string[], blockStart: number): number | null {
  let found: number | null = null
  for (let c = 0; c < blockStart - 1; c++) {
    if (tokenize(headerCells[c]).some((t) => ALIASES.exercise.includes(t))) found = c + 1
  }
  return found
}

export function parseHorizontal(
  readRow: ReadRow,
  maxRow: number,
  banner: { row: number; weekCols: number[] },
): ParseResult {
  const warnings: ExternalImportWarning[] = []
  const errors: string[] = []

  // The "Week N" banners align with each week's column group → block starts.
  const weekCols = banner.weekCols
  const blockWidth = weekCols.length >= 2 ? weekCols[1] - weekCols[0] : 8

  // Label row = first row at/after the banner whose first block holds the
  // Sets/Reps headers (these repeat per week block in every horizontal layout).
  let labelRow = 0
  const limit = Math.min(maxRow, banner.row + 8)
  for (let r = banner.row; r <= limit; r++) {
    const b0 = readRow(r).slice(weekCols[0] - 1, weekCols[0] - 1 + blockWidth).join(' ').toLowerCase()
    if (/\bset/.test(b0) && /\brep/.test(b0)) { labelRow = r; break }
  }
  if (!labelRow) {
    errors.push('Could not find the Sets/Reps column headers under the week blocks.')
    return { columnMapping: emptyMapping(), weeks: 0, days: 0, exerciseCount: 0, exercises: [], warnings, errors }
  }

  const headerCells = readRow(labelRow)
  const fields = resolveBlockFields(headerCells, weekCols[0], blockWidth)

  // The exercise name is EITHER inside each block (CoachBoard export, Layout A)
  // OR a single shared column to the left of the blocks (most powerlifting
  // templates, Layout B — name written once, weeks hold only the numbers).
  const sharedNameCol = fields.name === null ? findSharedNameCol(headerCells, weekCols[0]) : null

  const missing: string[] = []
  if (fields.name === null && sharedNameCol === null) missing.push('Exercise/Discipline')
  if (fields.sets === null) missing.push('Sets')
  if (fields.reps === null) missing.push('Reps')
  if (missing.length > 0) {
    errors.push(`Required column(s) not found: ${missing.join(', ')}. The file cannot be imported.`)
    return { columnMapping: emptyMapping(), weeks: 0, days: 0, exerciseCount: 0, exercises: [], warnings, errors }
  }
  if (fields.loadUsed === null) {
    warnings.push({ message: 'No "Load Used" column found — the program will have no load data.' })
  }
  if (fields.rpe === null) {
    warnings.push({ message: 'No RPE/RIR column found — no effort analysis will be available for this program.' })
  }

  const exercises: ExternalExerciseRow[] = []
  let dayIndex = -1
  let dayLabel = ''
  let sharedName = ''                                          // carry-forward for Layout B
  const blockName: string[] = new Array(weekCols.length).fill('') // carry-forward for Layout A

  for (let r = labelRow; r <= maxRow; r++) {
    const cells = readRow(r)

    // Weekday in column 1 starts a new day section (Mon=0 … Sun=6).
    const wd = weekdayOffset(cells[0] ?? '')
    if (wd !== null) {
      dayIndex = wd
      dayLabel = (cells[0] ?? '').trim()
      sharedName = ''
      blockName.fill('')
      continue
    }
    if (dayIndex < 0) continue // before the first day

    // Skip repeated label rows (a header has both "Sets" and "Reps" words;
    // exercise rows hold numbers, so this won't catch a name containing "set").
    const blk0 = cells.slice(weekCols[0] - 1, weekCols[0] - 1 + blockWidth).join(' ').toLowerCase()
    if (/\bsets?\b/.test(blk0) && /\breps?\b/.test(blk0)) continue

    // Shared (left-column) name for Layout B, with carry-forward over sub-sets.
    let rowSharedName = ''
    if (sharedNameCol !== null) {
      const v = (cells[sharedNameCol - 1] ?? '').trim()
      if (v) sharedName = v
      rowSharedName = sharedName
    }

    for (let w = 0; w < weekCols.length; w++) {
      const base = weekCols[w]
      const get = (off: number | null) => (off === null ? '' : (cells[base - 1 + off] ?? ''))

      let name: string
      if (fields.name !== null) {
        name = get(fields.name)
        if (name) blockName[w] = name
        else name = blockName[w]
      } else {
        name = rowSharedName
      }

      const setsText = get(fields.sets)
      const repsText = get(fields.reps)
      const intensityText = get(fields.intensity)
      const loadCapText = get(fields.loadCap)
      const loadUsedText = get(fields.loadUsed)
      const rpeText = get(fields.rpe)
      const restText = get(fields.restTime)

      const hasData = !!(setsText || repsText || intensityText || loadCapText || loadUsedText || rpeText)
      if (!name || !hasData) continue

      exercises.push({
        weekIndex: w,
        dayIndex,
        weekLabel: `Week ${w + 1}`,
        dayLabel: dayLabel || `Day ${dayIndex + 1}`,
        name,
        sets: setsText || null,
        reps: normalizeReps(repsText, r, warnings),
        load: normalizeLoad(loadUsedText, r, warnings),
        rpe: normalizeRpe(rpeText, fields.rpeFromRir, r, warnings),
        sheetRow: r,
        intensity: normalizeIntensity(intensityText),
        loadCap: normalizeLoadCap(loadCapText),
        restTime: restText || null,
        refillCols: {
          name: fields.name !== null ? base + fields.name : sharedNameCol,
          sets: fields.sets !== null ? base + fields.sets : null,
          reps: fields.reps !== null ? base + fields.reps : null,
          load: fields.loadUsed !== null ? base + fields.loadUsed : null,
          rpe: fields.rpe !== null ? base + fields.rpe : null,
          erpe: null,
        },
      })
    }
  }

  const b0 = weekCols[0]
  const mapping: ExternalColumnMapping = {
    exercise: fields.name !== null ? b0 + fields.name : sharedNameCol,
    sets: fields.sets !== null ? b0 + fields.sets : null,
    reps: fields.reps !== null ? b0 + fields.reps : null,
    load: fields.loadUsed !== null ? b0 + fields.loadUsed : null,
    rpe: fields.rpe !== null ? b0 + fields.rpe : null,
    rpeFromRir: fields.rpeFromRir,
  }

  if (exercises.length === 0) {
    warnings.push({ message: 'No exercise rows were detected under the week blocks.' })
  }

  return {
    headerRow: labelRow,
    columnMapping: mapping,
    weeks: new Set(exercises.map((e) => e.weekIndex)).size,
    days: new Set(exercises.map((e) => `${e.weekIndex}-${e.dayIndex}`)).size,
    exerciseCount: exercises.length,
    exercises,
    warnings,
    errors,
  }
}
