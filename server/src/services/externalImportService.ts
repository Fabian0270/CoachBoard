import ExcelJS from 'exceljs'
import type {
  ExternalColumnKey,
  ExternalColumnMapping,
  ExternalExerciseRow,
  ExternalImportPreview,
  ExternalImportWarning,
} from 'coachboard-shared'

// ---------------------------------------------------------------------------
// External import parser (Feature 4a)
//
// Unlike importService.ts — which reads back CoachBoard's OWN export by
// replaying the exporter's exact (row, col) math — this parser receives an
// arbitrary Excel file and must DISCOVER its structure:
//   1. detect the header row and map columns to known fields
//   2. detect week/day section headers
//   3. detect exercise rows (with multi-set carry-forward)
//   4. normalise cell values (RIR→RPE, Swedish decimals, ranges, bodyweight)
//
// Pure function of the buffer — no DB access — so it is trivially unit-testable.
// ---------------------------------------------------------------------------

const HEADER_SCAN_ROWS = 10

const ALIASES: Record<ExternalColumnKey, string[]> = {
  exercise: ['exercise', 'movement', 'lift', 'name', 'discipline'],
  sets: ['sets', 'set'],
  reps: ['reps', 'rep', 'repetitions'],
  load: ['load', 'weight', 'kg', 'lbs', 'lb', 'intensity'],
  rpe: ['rpe', 'effort'],
}
const RIR_ALIASES = ['rir']

// Keys resolved in this order so a more specific header wins a shared token.
// e.g. "Last Set RPE" tokenises to [last, set, rpe]; resolving rpe before sets
// claims that column for rpe, leaving a plain "Sets" column free for sets.
const RESOLVE_ORDER: ExternalColumnKey[] = ['exercise', 'rpe', 'reps', 'sets', 'load']

/** Convert any ExcelJS cell value into trimmed plain text. */
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim()
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>
    if ('text' in v && typeof v.text === 'string') return v.text.trim()
    if ('result' in v && v.result !== undefined && v.result !== null) return String(v.result).trim()
    if ('richText' in v && Array.isArray(v.richText)) {
      return v.richText.map((r: { text?: string }) => r.text ?? '').join('').trim()
    }
    if ('formula' in v) return '' // formula with no cached result
  }
  return String(value).trim()
}

const tokenize = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

const NUMERIC = /^\d+(\.\d+)?$/
const RANGE = /^\d+(\.\d+)?\s*[-–—]\s*\d+(\.\d+)?$/

/** A sets/reps cell that looks like a number or a range ("3", "3-5", "3–5"). */
function isNumericLike(text: string): boolean {
  const t = text.trim()
  return NUMERIC.test(t) || RANGE.test(t)
}

function classifySectionHeader(text: string): 'week' | 'day' | 'unknown' {
  const t = text.trim().toLowerCase()
  if (/^(week|block|phase|meso\w*)\b/.test(t) && /\d/.test(t)) return 'week'
  if (/^w\s*\d+/.test(t)) return 'week'
  if (/^(day|session)\b/.test(t)) return 'day'
  if (/^(mon|tue|wed|thu|fri|sat|sun)/.test(t)) return 'day'
  if (/^(upper|lower|push|pull|legs|full\s*body)\b/.test(t)) return 'day'
  return 'unknown'
}

interface ResolvedHeader {
  mapping: ExternalColumnMapping
  matchCount: number
}

/** Assign worksheet columns to field keys for one candidate header row. */
function resolveHeaderRow(cellTexts: string[]): ResolvedHeader {
  const tokensByCol = cellTexts.map(tokenize)
  const claimed = new Set<number>()
  const mapping: ExternalColumnMapping = {
    exercise: null, sets: null, reps: null, load: null, rpe: null, rpeFromRir: false,
  }

  for (const key of RESOLVE_ORDER) {
    const aliases = key === 'rpe' ? [...ALIASES.rpe, ...RIR_ALIASES] : ALIASES[key]
    for (let c = 0; c < tokensByCol.length; c++) {
      if (claimed.has(c)) continue
      const tokens = tokensByCol[c]
      const hit = tokens.find((t) => aliases.includes(t))
      if (hit) {
        mapping[key] = c + 1 // 1-based column index
        claimed.add(c)
        if (key === 'rpe' && RIR_ALIASES.includes(hit)) mapping.rpeFromRir = true
        break
      }
    }
  }

  const matchCount = (['exercise', 'sets', 'reps', 'load', 'rpe'] as const)
    .filter((k) => mapping[k] !== null).length
  return { mapping, matchCount }
}

export async function parseExternalFile(buffer: Buffer): Promise<ExternalImportPreview> {
  const warnings: ExternalImportWarning[] = []
  const errors: string[] = []
  const empty: ExternalImportPreview = {
    columnMapping: { exercise: null, sets: null, reps: null, load: null, rpe: null, rpeFromRir: false },
    weeks: 0, days: 0, exerciseCount: 0, exercises: [], warnings, errors,
  }

  const wb = new ExcelJS.Workbook()
  // ExcelJS's Buffer type diverges from Node's generic Buffer<ArrayBufferLike>
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  const ws = wb.worksheets[0]
  if (!ws) {
    errors.push('No worksheet found in the uploaded file.')
    return empty
  }

  const maxCol = Math.max(ws.columnCount || 0, 1)
  const maxRow = ws.rowCount || 0
  const readRow = (r: number): string[] => {
    const out: string[] = []
    for (let c = 1; c <= maxCol; c++) out.push(cellToString(ws.getCell(r, c).value))
    return out
  }

  // -------------------------------------------------------------------------
  // 1. Header detection — pick the row in the first HEADER_SCAN_ROWS with the
  //    most resolvable field columns.
  // -------------------------------------------------------------------------
  let headerRow = 0
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
    errors.push('Could not find a header row. Expected columns like Exercise, Sets, Reps, Load, RPE.')
    return empty
  }

  const mapping = best.mapping
  empty.columnMapping = mapping

  const missing: string[] = []
  if (mapping.exercise === null) missing.push('Exercise')
  if (mapping.sets === null) missing.push('Sets')
  if (mapping.reps === null) missing.push('Reps')
  if (missing.length > 0) {
    errors.push(`Required column(s) not found: ${missing.join(', ')}. The file cannot be imported.`)
    return { ...empty, columnMapping: mapping }
  }
  if (mapping.load === null) {
    warnings.push({ message: 'No Load/Weight column found — the program can be stored but will have no load data.' })
  }
  if (mapping.rpe === null) {
    warnings.push({ message: 'No RPE/RIR column found — no effort analysis will be available for this program.' })
  }

  // -------------------------------------------------------------------------
  // 2 + 3. Walk the rows after the header, tracking week/day sections and
  //         collecting exercise rows.
  // -------------------------------------------------------------------------
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

    // ---- exercise-shaped row: sets cell is numeric/range ----
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

      const repsText = col(cells, mapping.reps)
      const loadText = col(cells, mapping.load)
      const rpeText = col(cells, mapping.rpe)

      // reps — kept as-is; flag variable schemes
      const reps = repsText || null
      if (reps && /amrap|as needed|max reps/i.test(reps)) {
        warnings.push({ sheetRow: r, message: `Row ${r}: variable reps "${reps}" kept as-is (no fixed value).` })
      }

      // load — bodyweight → null; strip units; warn on unparseable text
      let load: string | null = null
      if (loadText) {
        if (/^bw$|body\s*weight/i.test(loadText)) {
          load = null
        } else {
          const norm = loadText.replace(',', '.')
          const num = norm.match(/^(\d+(?:\.\d+)?)\s*(kg|lbs|lb)?$/i)
          if (num) {
            load = num[1]
          } else {
            warnings.push({ sheetRow: r, message: `Row ${r}: could not read load "${loadText}" — left blank.` })
          }
        }
      }

      // rpe — RIR converts to RPE; warn on unparseable text
      let rpe: string | null = null
      if (rpeText) {
        const num = parseFloat(rpeText.replace(',', '.'))
        if (isNaN(num)) {
          warnings.push({ sheetRow: r, message: `Row ${r}: could not read ${mapping.rpeFromRir ? 'RIR' : 'RPE'} "${rpeText}" — left blank.` })
        } else if (mapping.rpeFromRir) {
          rpe = String(10 - num)
        } else {
          rpe = String(num)
        }
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
        reps,
        load,
        rpe,
        sheetRow: r,
      })
      continue
    }

    // ---- not an exercise row → maybe a section header ----
    if (nonEmpty.length <= 2) {
      const joined = nonEmpty.join(' ')
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
    // multi-cell non-exercise rows (e.g. notes) are silently skipped
  }

  const weeks = new Set(exercises.map((e) => e.weekIndex)).size
  const days = new Set(exercises.map((e) => `${e.weekIndex}-${e.dayIndex}`)).size

  if (exercises.length === 0) {
    warnings.push({ message: 'No exercise rows were detected in the file.' })
  }

  return {
    columnMapping: mapping,
    weeks,
    days,
    exerciseCount: exercises.length,
    exercises,
    warnings,
    errors,
  }
}
