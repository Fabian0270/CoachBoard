import ExcelJS from 'exceljs'
import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'
import { findAthleteById } from './athleteService.js'
import type {
  ExternalColumnKey,
  ExternalColumnMapping,
  ExternalExerciseRow,
  ExternalImportCommitResult,
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

// --- shared value normalisation (used by both layout parsers) ---

const BODYWEIGHT = /^bw$|body\s*weight/i

function normalizeReps(text: string, sheetRow: number, warnings: ExternalImportWarning[]): string | null {
  let reps = text || null
  if (reps) {
    // Excel silently turns a rep RANGE like "4-8" or "6-10" into a date
    // (e.g. 2025-04-08). Recover it as month-day → "4-8".
    const d = reps.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (d) reps = `${parseInt(d[2], 10)}-${parseInt(d[3], 10)}`
    if (/amrap|as needed|max reps/i.test(reps)) {
      warnings.push({ sheetRow, message: `Row ${sheetRow}: variable reps "${reps}" kept as-is (no fixed value).` })
    }
  }
  return reps
}

/** Intensity/Weight free-text; a bare decimal fraction (|n|<1) is a % backoff. */
function normalizeIntensity(text: string): string | null {
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
function normalizeLoad(text: string, sheetRow: number, warnings: ExternalImportWarning[]): string | null {
  if (!text) return null
  if (BODYWEIGHT.test(text)) return null
  const m = text.replace(',', '.').match(/^(\d+(?:\.\d+)?)\s*(kg|lbs|lb)?$/i)
  if (m) return m[1]
  warnings.push({ sheetRow, message: `Row ${sheetRow}: could not read load "${text}" — left blank.` })
  return null
}

/** "Load Cap" → number (best-effort, ignores trailing text); null if none. */
function normalizeLoadCap(text: string): number | null {
  if (!text) return null
  const m = text.replace(',', '.').match(/^(\d+(?:\.\d+)?)/)
  return m ? parseFloat(m[1]) : null
}

function normalizeRpe(text: string, fromRir: boolean, sheetRow: number, warnings: ExternalImportWarning[]): string | null {
  if (!text) return null
  const num = parseFloat(text.replace(',', '.'))
  if (isNaN(num)) {
    warnings.push({ sheetRow, message: `Row ${sheetRow}: could not read ${fromRir ? 'RIR' : 'RPE'} "${text}" — left blank.` })
    return null
  }
  return fromRir ? String(10 - num) : String(num)
}

const WEEKDAY_PREFIXES = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
/** Weekday name → 0..6 (Mon..Sun), or null. */
function weekdayOffset(text: string): number | null {
  const t = text.trim().toLowerCase()
  for (let i = 0; i < WEEKDAY_PREFIXES.length; i++) {
    if (t.startsWith(WEEKDAY_PREFIXES[i])) return i
  }
  return null
}

const emptyMapping = (): ExternalColumnMapping =>
  ({ exercise: null, sets: null, reps: null, load: null, rpe: null, rpeFromRir: false })

type ParseResult = Omit<ExternalImportPreview, 'layout'>
type ReadRow = (r: number) => string[]

function makeReadRow(ws: ExcelJS.Worksheet, maxCol: number): ReadRow {
  return (r) => {
    const out: string[] = []
    for (let c = 1; c <= maxCol; c++) out.push(cellToString(ws.getCell(r, c).value))
    return out
  }
}

const WEEK_BANNER = /^(week|w)\s*\d+$/i

/**
 * A row holding ≥2 *distinct* "Week N" banners marks a horizontal layout.
 * Dedupe by label text: a merged single banner ("Week 1" spanning columns)
 * reads as the same value repeated and must NOT be mistaken for multiple weeks.
 */
function findWeekBannerRow(readRow: ReadRow, maxRow: number): { row: number; weekCols: number[] } | null {
  const scan = Math.min(maxRow, 15)
  for (let r = 1; r <= scan; r++) {
    const cells = readRow(r)
    const firstColByLabel = new Map<string, number>()
    for (let c = 0; c < cells.length; c++) {
      const text = cells[c].trim()
      if (WEEK_BANNER.test(text)) {
        const key = text.toLowerCase()
        if (!firstColByLabel.has(key)) firstColByLabel.set(key, c + 1)
      }
    }
    if (firstColByLabel.size >= 2) {
      return { row: r, weekCols: [...firstColByLabel.values()].sort((a, b) => a - b) }
    }
  }
  return null
}

export async function parseExternalFile(buffer: Buffer): Promise<ExternalImportPreview> {
  const wb = new ExcelJS.Workbook()
  // ExcelJS's Buffer type diverges from Node's generic Buffer<ArrayBufferLike>
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  const ws = wb.worksheets[0]
  if (!ws) {
    return {
      layout: 'vertical', columnMapping: emptyMapping(), weeks: 0, days: 0,
      exerciseCount: 0, exercises: [], warnings: [], errors: ['No worksheet found in the uploaded file.'],
    }
  }

  const maxCol = Math.max(ws.columnCount || 0, 1)
  const maxRow = ws.rowCount || 0
  const readRow = makeReadRow(ws, maxCol)

  const banner = findWeekBannerRow(readRow, maxRow)
  if (banner) {
    return { layout: 'horizontal', ...parseHorizontal(readRow, maxRow, banner) }
  }
  return { layout: 'vertical', ...parseVertical(readRow, maxRow) }
}

// ---------------------------------------------------------------------------
// Vertical layout — weeks/days are section-header ROWS stacked top-to-bottom.
// ---------------------------------------------------------------------------
function parseVertical(readRow: ReadRow, maxRow: number): ParseResult {
  const warnings: ExternalImportWarning[] = []
  const errors: string[] = []

  // 1. Header detection — the row in the first HEADER_SCAN_ROWS with the most fields.
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
    return { columnMapping: emptyMapping(), weeks: 0, days: 0, exerciseCount: 0, exercises: [], warnings, errors }
  }

  const mapping = best.mapping
  const missing: string[] = []
  if (mapping.exercise === null) missing.push('Exercise')
  if (mapping.sets === null) missing.push('Sets')
  if (mapping.reps === null) missing.push('Reps')
  if (missing.length > 0) {
    errors.push(`Required column(s) not found: ${missing.join(', ')}. The file cannot be imported.`)
    return { columnMapping: mapping, weeks: 0, days: 0, exerciseCount: 0, exercises: [], warnings, errors }
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
      })
      continue
    }

    // not an exercise row → maybe a section header
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
  }

  if (exercises.length === 0) warnings.push({ message: 'No exercise rows were detected in the file.' })

  return {
    columnMapping: mapping,
    weeks: new Set(exercises.map((e) => e.weekIndex)).size,
    days: new Set(exercises.map((e) => `${e.weekIndex}-${e.dayIndex}`)).size,
    exerciseCount: exercises.length,
    exercises,
    warnings,
    errors,
  }
}

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

function parseHorizontal(
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
    columnMapping: mapping,
    weeks: new Set(exercises.map((e) => e.weekIndex)).size,
    days: new Set(exercises.map((e) => `${e.weekIndex}-${e.dayIndex}`)).size,
    exerciseCount: exercises.length,
    exercises,
    warnings,
    errors,
  }
}

// ---------------------------------------------------------------------------
// Commit (Feature 4b) — materialise parsed rows into a real, editable program.
//
// Each detected (week, day) block becomes one workout placed on the calendar
// in order from the start Monday, so the native day editor renders every day
// in sequence. Exercise order is preserved; consecutive same-name rows share a
// group_id so multi-set/carry-forward rows stay grouped like native sets.
// ---------------------------------------------------------------------------

const toIso = (d: Date): string => d.toISOString().slice(0, 10)

function mondayOf(isoDate: string): Date {
  const [y, m, d] = isoDate.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const dow = date.getUTCDay()
  const offset = dow === 0 ? -6 : 1 - dow
  date.setUTCDate(date.getUTCDate() + offset)
  return date
}

function addDays(start: Date, days: number): string {
  const d = new Date(start)
  d.setUTCDate(start.getUTCDate() + days)
  return toIso(d)
}

const sameName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

export async function commitExternalProgram(
  exercises: ExternalExerciseRow[],
  meta: { athleteId: string; name: string; status: string; startDate?: string | null; weeks: number },
): Promise<ExternalImportCommitResult> {
  const athlete = await findAthleteById(meta.athleteId)
  if (!athlete) throw new Error(`Athlete not found: ${meta.athleteId}`)

  // Archived historical imports may omit a start date — fall back to this week's
  // Monday so days still land on the calendar in order (the program is hidden
  // from the active roster anyway, and the relative week structure is preserved).
  const startMonday = mondayOf(meta.startDate || toIso(new Date()))
  const weeks = Math.max(meta.weeks, 1)
  const now = new Date().toISOString()
  const programId = uuidv4()

  // Group rows by (week, day) block, preserving in-sheet order.
  const blocks = new Map<string, ExternalExerciseRow[]>()
  for (const ex of exercises) {
    const key = `${ex.weekIndex}-${ex.dayIndex}`
    const list = blocks.get(key) ?? []
    list.push(ex)
    blocks.set(key, list)
  }

  const db = getDb()
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('programs')
      .values({
        id: programId,
        athlete_id: meta.athleteId,
        name: meta.name,
        description: null,
        start_date: toIso(startMonday),
        end_date: addDays(startMonday, weeks * 7 - 1),
        status: meta.status,
        enabled_columns: null,
        created_at: now,
        updated_at: now,
      })
      .execute()

    for (const rows of blocks.values()) {
      const { weekIndex, dayIndex } = rows[0]
      const workoutDate = addDays(startMonday, weekIndex * 7 + Math.min(dayIndex, 6))
      const workoutId = uuidv4()

      await trx
        .insertInto('workouts')
        .values({
          id: workoutId,
          program_id: programId,
          name: workoutDate,
          scheduled_date: workoutDate,
          notes: null,
          created_at: now,
        })
        .execute()

      let groupId: string | null = null
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const prev = i > 0 ? rows[i - 1] : null
        const next = i < rows.length - 1 ? rows[i + 1] : null

        // Start a new group when this row begins a run of same-named rows.
        if (prev && sameName(prev.name, row.name)) {
          // continue current group
        } else if (next && sameName(next.name, row.name)) {
          groupId = uuidv4()
        } else {
          groupId = null
        }

        await trx
          .insertInto('exercises')
          .values({
            id: uuidv4(),
            workout_id: workoutId,
            name: row.name,
            sets: row.sets,
            reps: row.reps,
            weight: row.loadCap ?? null,
            duration: null,
            distance: null,
            notes: null,
            order_index: i,
            rest_time: row.restTime ?? null,
            intensity: row.intensity ?? null,
            load_used: row.load,
            rpe: row.rpe,
            group_id: groupId,
            suggestion_note: null,
          })
          .execute()
      }
    }
  })

  return { programId }
}
