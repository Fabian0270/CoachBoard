import type {
  ExternalColumnMapping,
  ExternalExerciseRow,
  ExternalImportWarning,
  ExternalParseOverrides,
} from 'coachboard-shared'
import { isNumericLike, classifySectionHeader } from '../cellParsing.js'
import { resolveHeaderRow, type ResolvedHeader } from '../headerDetection.js'
import { normalizeReps, normalizeLoad, normalizeRpe } from '../valueNormalizers.js'
import { emptyMapping, hasParseOverride, type ParseResult, type ReadRow } from '../shared.js'

const HEADER_SCAN_ROWS = 10

// ---------------------------------------------------------------------------
// Vertical layout — weeks/days are section-header ROWS stacked top-to-bottom.
// ---------------------------------------------------------------------------
export function parseVertical(readRow: ReadRow, maxRow: number, overrides?: ExternalParseOverrides): ParseResult {
  const warnings: ExternalImportWarning[] = []
  const errors: string[] = []

  // 1. Header row — forced by override, else the row in the first HEADER_SCAN_ROWS
  // with the most recognised fields.
  let headerRow = overrides?.headerRow ?? 0
  let mapping: ExternalColumnMapping
  if (headerRow > 0) {
    mapping = resolveHeaderRow(readRow(headerRow)).mapping
  } else {
    let best: ResolvedHeader | null = null
    const scanLimit = Math.min(maxRow, HEADER_SCAN_ROWS)
    for (let r = 1; r <= scanLimit; r++) {
      const resolved = resolveHeaderRow(readRow(r))
      if (!best || resolved.matchCount > best.matchCount) {
        best = resolved
        headerRow = r
      }
    }
    if (!best || best.matchCount === 0) {
      // Nothing auto-detected and no manual mapping → surface the header row so the
      // wizard can offer remapping, with a clear error.
      if (!hasParseOverride(overrides)) {
        errors.push('Could not find a header row. Expected columns like Exercise, Sets, Reps, Load, RPE.')
        return { headerRow, columnMapping: emptyMapping(), weeks: 0, days: 0, exerciseCount: 0, exercises: [], warnings, errors }
      }
    }
    mapping = best ? { ...best.mapping } : emptyMapping()
  }

  // 2. Apply the coach's explicit overrides on top of detection (null = clear).
  if (overrides) {
    if (overrides.exercise !== undefined) mapping.exercise = overrides.exercise
    if (overrides.sets !== undefined) mapping.sets = overrides.sets
    if (overrides.reps !== undefined) mapping.reps = overrides.reps
    if (overrides.load !== undefined) mapping.load = overrides.load
    if (overrides.rpe !== undefined) mapping.rpe = overrides.rpe
    if (overrides.rpeFromRir !== undefined) mapping.rpeFromRir = overrides.rpeFromRir
  }

  // 3. Required columns.
  const missing: string[] = []
  if (mapping.exercise === null) missing.push('Exercise')
  if (mapping.sets === null) missing.push('Sets')
  if (mapping.reps === null) missing.push('Reps')
  if (missing.length > 0) {
    errors.push(`Required column(s) not found: ${missing.join(', ')}. The file cannot be imported.`)
    return { headerRow, columnMapping: mapping, weeks: 0, days: 0, exerciseCount: 0, exercises: [], warnings, errors }
  }
  if (mapping.load === null) {
    warnings.push({ message: 'No Load/Weight column found — the program can be stored but will have no load data.' })
  }
  if (mapping.rpe === null) {
    warnings.push({ message: 'No RPE/RIR column found — no effort analysis will be available for this program.' })
  }

  // 2 + 3. Walk rows, tracking week/day sections and collecting exercise rows.
  const exercises: ExternalExerciseRow[] = []
  let weekIdx = -1
  let dayIdx = -1
  let weekLabel = ''
  let dayLabel = ''
  let carryName = ''

  const col = (cells: string[], idx: number | null): string =>
    idx === null ? '' : (cells[idx - 1] ?? '')

  for (let r = headerRow + 1; r <= maxRow; r++) {
    const cells = readRow(r)
    const nonEmpty = cells.filter((c) => c !== '')
    if (nonEmpty.length === 0) continue // blank separator

    const setsText = col(cells, mapping.sets)
    const nameText = col(cells, mapping.exercise)

    if (setsText && isNumericLike(setsText)) {
      let name = nameText
      if (!name) {
        if (carryName) {
          name = carryName // multi-set sub-row inherits the previous exercise name
        } else {
          warnings.push({ sheetRow: r, message: `Row ${r}: numeric sets but no exercise name — row skipped.` })
          continue
        }
      } else {
        carryName = name
      }

      const effWeek = weekIdx < 0 ? 0 : weekIdx
      const effDay = dayIdx < 0 ? 0 : dayIdx
      exercises.push({
        weekIndex: effWeek,
        dayIndex: effDay,
        weekLabel: weekIdx < 0 ? 'Week 1' : (weekLabel || `Week ${effWeek + 1}`),
        dayLabel: dayIdx < 0 ? 'Day 1' : (dayLabel || `Day ${effDay + 1}`),
        name,
        sets: setsText,
        reps: normalizeReps(col(cells, mapping.reps), r, warnings),
        load: normalizeLoad(col(cells, mapping.load), r, warnings),
        rpe: normalizeRpe(col(cells, mapping.rpe), mapping.rpeFromRir, r, warnings),
        sheetRow: r,
        refillCols: { name: mapping.exercise, sets: mapping.sets, reps: mapping.reps, load: mapping.load, rpe: mapping.rpe, erpe: null },
      })
      continue
    }

    // not an exercise row → maybe a section header. A merged banner ("Week 2"
    // spanning the table width) echoes its master value across every spanned
    // column, so a row whose non-empty cells are all the same text is one
    // logical banner, not a wide data row.
    const distinct = [...new Set(nonEmpty)]
    if (nonEmpty.length <= 2 || distinct.length === 1) {
      const joined = distinct.length === 1 ? distinct[0] : nonEmpty.join(' ')
      const cls = classifySectionHeader(joined)
      if (cls === 'week') {
        weekIdx++
        dayIdx = -1
        weekLabel = joined
        dayLabel = ''
        carryName = ''
      } else if (cls === 'day') {
        dayIdx++
        dayLabel = joined
        carryName = ''
      } else if (/[a-z]/i.test(joined)) {
        warnings.push({ sheetRow: r, message: `Row ${r}: unrecognised section header "${joined}" — ignored.` })
      }
    }
  }

  if (exercises.length === 0) warnings.push({ message: 'No exercise rows were detected in the file.' })

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
