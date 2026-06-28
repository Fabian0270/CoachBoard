import type {
  ExternalColumnMapping,
  ExternalExerciseRow,
  ExternalImportWarning,
} from 'coachboard-shared'
import { normalizeReps, normalizeLoad, weekdayOffset } from '../valueNormalizers.js'
import { emptyMapping, type ParseResult, type ReadRow } from '../shared.js'
import { resolveGridFields, normalizeBlockRpe } from './blockGridParser.js'

// ---------------------------------------------------------------------------
// Week-grid layout (Feature 4d). Weeks are side-by-side column
// blocks like block-grid, but three things set it apart:
//   1. each block's lead column (one LEFT of its "Week N" banner) holds BOTH the
//      movement names and the day-section labels — and those labels are weekday
//      NAMES (English or Swedish: "Tisdag"/"Torsdag"/…), not "DAY n";
//   2. the Set/Reps/RPE/Load header row appears ONCE (the first day's label
//      shares that header row's lead column), not repeated under every day;
//   3. extra "eRpe" (executed RPE) and "e1RM" (estimated 1RM formula) columns sit
//      after Load — both are derived/executed data and are ignored on import.
// RPE is written "@5-6" / "@7", reusing the block-grid's @-stripping.
// ---------------------------------------------------------------------------

export function parseWeekGrid(
  readRow: ReadRow,
  maxRow: number,
  banner: { row: number; weekCols: number[] },
  blockStarts: number[],
  headerRow: number,
): ParseResult {
  const warnings: ExternalImportWarning[] = []
  const errors: string[] = []

  const blockWidth = blockStarts.length >= 2 ? blockStarts[1] - blockStarts[0] : 8

  // Reuse the block-grid field resolver for Set/Reps/RPE/Load (it already skips
  // "eRpe" and ignores the "e1RM" formula column), then pin the name to the
  // lead column — its header here is a weekday, never a "Movement" word.
  const headerCells = readRow(headerRow)
  const fields = resolveGridFields(headerCells, blockStarts[0], blockWidth)
  fields.name = 0

  const missing: string[] = []
  if (fields.sets === null) missing.push('Set')
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

  // Real banner text per week ("Week 14" …) reads better than a synthetic label.
  const bannerCells = readRow(banner.row)
  const weekLabels = banner.weekCols.map((c, w) => (bannerCells[c - 1] ?? '').trim() || `Week ${w + 1}`)

  // The first day's label shares the header row's lead column ("Tisdag").
  const headerLead = (headerCells[blockStarts[0] - 1] ?? '').trim()
  let dayIndex = weekdayOffset(headerLead) ?? 0
  let dayLabel = headerLead || 'Day 1'

  const exercises: ExternalExerciseRow[] = []
  const blockName: string[] = new Array(blockStarts.length).fill('') // per-block name carry-forward

  for (let r = headerRow + 1; r <= maxRow; r++) {
    const cells = readRow(r)

    // A weekday name in the lead column, with the block's data cells empty,
    // starts a new day section (movement names never tokenise to a weekday).
    const lead = (cells[blockStarts[0] - 1] ?? '').trim()
    const wd = weekdayOffset(lead)
    if (wd !== null) {
      const get0 = (off: number | null) => (off === null ? '' : (cells[blockStarts[0] - 1 + off] ?? ''))
      if (!get0(fields.sets) && !get0(fields.reps) && !get0(fields.load)) {
        dayIndex = wd
        dayLabel = lead
        blockName.fill('')
        continue
      }
    }

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
        weekLabel: weekLabels[w],
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
    exercise: b0 + fields.name,
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
