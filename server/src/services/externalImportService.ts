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
  ExternalParseOverrides,
  ExportLayoutTemplate,
  SuggestionGoal,
} from 'coachboard-shared'
import {
  COLUMN_LABELS,
  type ExportColumnKey,
  type ExportLayoutColumn,
} from 'coachboard-shared/exportLayout'

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

// Header aliases, English + Swedish (the primary user base). Tokens are matched
// case-insensitively against tokenised header cells, so each entry is a single
// lowercased word (see tokenize, which preserves å/ä/ö).
const ALIASES: Record<ExternalColumnKey, string[]> = {
  exercise: ['exercise', 'movement', 'lift', 'name', 'discipline', 'övning', 'övningar', 'rörelse'],
  sets: ['sets', 'set', 'serie', 'serier'],
  reps: ['reps', 'rep', 'repetitions', 'repetition', 'repetitioner'],
  load: ['load', 'weight', 'kg', 'lbs', 'lb', 'intensity', 'intensitet', 'vikt', 'belastning', 'kilo'],
  rpe: ['rpe', 'effort', 'ansträngning'],
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
const tokenize = (text: string): string[] =>
  text.toLowerCase().split(/[^a-z0-9åäö]+/).filter(Boolean)

const NUMERIC = /^\d+(\.\d+)?$/
const RANGE = /^\d+(\.\d+)?\s*[-–—]\s*\d+(\.\d+)?$/

/** A sets/reps cell that looks like a number or a range ("3", "3-5", "3–5"). */
function isNumericLike(text: string): boolean {
  const t = text.trim()
  return NUMERIC.test(t) || RANGE.test(t)
}

// Week/day section detection, English + Swedish.
function classifySectionHeader(text: string): 'week' | 'day' | 'unknown' {
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

const BODYWEIGHT = /^bw$|^kv$|body\s*weight|kroppsvikt/i // EN "BW"/"bodyweight", SV "KV"/"kroppsvikt"

function normalizeReps(text: string, sheetRow: number, warnings: ExternalImportWarning[]): string | null {
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

// Prefix → 0..6 (Mon..Sun). English plus Swedish (Scandinavian coaching sheets
// label days "Tisdag"/"Torsdag"/…). ASCII fallbacks ('man','lor','son') cover
// files whose accented characters were stripped on a round-trip through Excel.
const WEEKDAY_PREFIXES: ReadonlyArray<readonly [string, number]> = [
  ['mon', 0], ['tue', 1], ['wed', 2], ['thu', 3], ['fri', 4], ['sat', 5], ['sun', 6],
  ['mån', 0], ['man', 0], ['tis', 1], ['ons', 2], ['tor', 3], ['fre', 4], ['lör', 5], ['lor', 5], ['sön', 6], ['son', 6],
]
/** Weekday name → 0..6 (Mon..Sun), or null. */
function weekdayOffset(text: string): number | null {
  const t = text.trim().toLowerCase()
  for (const [prefix, idx] of WEEKDAY_PREFIXES) {
    if (t.startsWith(prefix)) return idx
  }
  return null
}

const emptyMapping = (): ExternalColumnMapping =>
  ({ exercise: null, sets: null, reps: null, load: null, rpe: null, rpeFromRir: false })

// The internal parse result also carries `headerRow` — the worksheet row whose
// cells hold the column-header labels — so the style capture can sample fonts,
// colors and header wording from a known location. Not part of the public preview.
// headerRowIndex/headerCells/columnCount are derived once in parseExternalFile,
// not by the individual layout parsers, so they're omitted here.
type ParseResult = Omit<
  ExternalImportPreview,
  'layout' | 'suggestedFocus' | 'layoutTemplate' | 'headerRowIndex' | 'headerCells' | 'columnCount'
> & {
  headerRow?: number
}
type ReadRow = (r: number) => string[]

/** First number in a reps cell ("5", "3-5", "3–5") → the lower bound, or null. */
function repsLowerBound(reps: string | null): number | null {
  if (!reps) return null
  const m = reps.match(/\d+/)
  return m ? parseInt(m[0], 10) : null
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Best-guess training focus from the parsed rows — pre-selects the focus
 * dropdown in the import wizard (the coach always confirms). Uses the median
 * rep target, with a high final-week RPE nudging a borderline block to peaking.
 * Returns null when no numeric reps are present to judge from.
 */
export function guessFocus(exercises: ExternalExerciseRow[]): SuggestionGoal | null {
  const reps = exercises
    .map((e) => repsLowerBound(e.reps))
    .filter((n): n is number => n !== null)
  if (reps.length === 0) return null

  const medReps = median(reps)

  // Average RPE in the final week (when RPE was parsed) — a near-maximal finish
  // on a low-rep block is the signature of a peak.
  const maxWeek = Math.max(...exercises.map((e) => e.weekIndex))
  const finalRpes = exercises
    .filter((e) => e.weekIndex === maxWeek && e.rpe)
    .map((e) => parseFloat(e.rpe!.replace(',', '.')))
    .filter((n) => !isNaN(n))
  const finalAvgRpe = finalRpes.length ? finalRpes.reduce((a, b) => a + b, 0) / finalRpes.length : null

  if (medReps <= 3) return 'peaking'
  if (medReps <= 6) return finalAvgRpe !== null && finalAvgRpe >= 9 ? 'peaking' : 'strength'
  return 'hypertrophy'
}

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

// ---------------------------------------------------------------------------
// Layout template capture — read the uploaded file's styling + structure into
// an ExportLayoutTemplate so any program based on this import re-exports in the
// coach's own look (colors, fonts, orientation, day labels) rather than
// CoachBoard's generic style. Sampled from representative cells located via the
// detection results (header row, banner cell, first data row).
// ---------------------------------------------------------------------------

/** Solid-fill ARGB at a cell, or null (theme fills / no fill / out of range → null). */
function cellFillArgb(ws: ExcelJS.Worksheet, row: number, col: number): string | null {
  if (row < 1 || col < 1) return null
  const fill = ws.getCell(row, col).fill as ExcelJS.Fill | undefined
  if (fill && fill.type === 'pattern' && fill.pattern === 'solid') {
    const argb = (fill as ExcelJS.FillPattern).fgColor?.argb
    if (typeof argb === 'string') return argb
  }
  return null
}

function cellFont(ws: ExcelJS.Worksheet, row: number, col: number): Partial<ExcelJS.Font> {
  if (row < 1 || col < 1) return {}
  return ws.getCell(row, col).font ?? {}
}

const EXTERNAL_TO_EXPORT_KEY: Record<ExternalColumnKey, ExportColumnKey> = {
  exercise: 'name', sets: 'sets', reps: 'reps', load: 'load_used', rpe: 'rpe',
}

/** Distinctly-Swedish weekday prefixes (accented + ASCII-safe forms). */
const SV_DAY_MARKERS = ['mån', 'man', 'tis', 'ons', 'tor', 'fre', 'lör', 'lor', 'sön', 'son']

function captureLayoutTemplate(
  ws: ExcelJS.Worksheet,
  info: {
    orientation: ExportLayoutTemplate['orientation']
    columnMapping: ExternalColumnMapping
    exercises: ExternalExerciseRow[]
    headerRow?: number
    bannerRow: number | null
    bannerCol: number | null
  },
): ExportLayoutTemplate {
  const { orientation, columnMapping, exercises, headerRow, bannerRow, bannerCol } = info
  const nameCol = columnMapping.exercise
  const rpeCol = columnMapping.rpe
  const bodyRow = exercises[0]?.sheetRow ?? null

  // --- columns + the coach's own header wording ---
  const columns: ExportLayoutColumn[] = []
  for (const extKey of ['exercise', 'sets', 'reps', 'load', 'rpe'] as ExternalColumnKey[]) {
    const colIdx = columnMapping[extKey]
    if (typeof colIdx !== 'number') continue
    const expKey = EXTERNAL_TO_EXPORT_KEY[extKey]
    const headerText = headerRow ? cellToString(ws.getCell(headerRow, colIdx).value) : ''
    columns.push({ key: expKey, label: headerText || COLUMN_LABELS[expKey] })
  }

  // --- day labels + language (from the detected day-section labels) ---
  const labelByDay = new Map<number, string>()
  for (const ex of exercises) {
    if (!labelByDay.has(ex.dayIndex) && ex.dayLabel) labelByDay.set(ex.dayIndex, ex.dayLabel)
  }
  let sawWeekday = false
  let sawDayN = false
  let language: 'en' | 'sv' = 'en'
  for (const label of labelByDay.values()) {
    if (/^day\s*\d+/i.test(label)) sawDayN = true
    else if (weekdayOffset(label) !== null) sawWeekday = true
    if (SV_DAY_MARKERS.some((m) => label.toLowerCase().startsWith(m))) language = 'sv'
  }
  const dayStyle: ExportLayoutTemplate['dayLabels']['style'] =
    sawWeekday ? 'weekday' : sawDayN ? 'dayN' : 'split'
  const maxDay = labelByDay.size ? Math.max(...labelByDay.keys()) : -1
  const custom: (string | null)[] = []
  for (let i = 0; i <= maxDay; i++) custom[i] = labelByDay.get(i) ?? null

  // --- RPE notation: a leading "@" in the source RPE cell ("@8") ---
  let rpeNotation: ExportLayoutTemplate['rpeNotation'] = 'plain'
  if (typeof rpeCol === 'number') {
    for (const ex of exercises.slice(0, 20)) {
      if (cellToString(ws.getCell(ex.sheetRow, rpeCol).value).startsWith('@')) {
        rpeNotation = 'at'
        break
      }
    }
  }

  // --- colors + fonts sampled from representative cells ---
  const headerFont = headerRow && nameCol ? cellFont(ws, headerRow, nameCol) : {}
  const columnHeader = headerRow && nameCol ? cellFillArgb(ws, headerRow, nameCol) : null
  return {
    version: 1,
    orientation,
    columns,
    dayLabels: { style: dayStyle, language, custom },
    rpeNotation,
    colors: {
      weekBanner: bannerRow && bannerCol ? cellFillArgb(ws, bannerRow, bannerCol) : columnHeader,
      dayHeader: headerRow ? cellFillArgb(ws, headerRow, 1) : null,
      columnHeader,
      trackingHeader: headerRow && typeof rpeCol === 'number' ? cellFillArgb(ws, headerRow, rpeCol) : null,
      body: bodyRow && nameCol ? cellFillArgb(ws, bodyRow, nameCol) : null,
    },
    fonts: {
      headerBold: !!headerFont.bold,
      headerItalic: !!headerFont.italic,
      nameBold: bodyRow && nameCol ? !!cellFont(ws, bodyRow, nameCol).bold : false,
    },
  }
}

// True when the coach supplied any manual override (forces the vertical parser).
function hasParseOverride(o?: ExternalParseOverrides): boolean {
  return !!o && (
    o.headerRow !== undefined || o.rpeFromRir !== undefined ||
    o.exercise !== undefined || o.sets !== undefined || o.reps !== undefined ||
    o.load !== undefined || o.rpe !== undefined
  )
}

export async function parseExternalFile(
  buffer: Buffer,
  overrides?: ExternalParseOverrides,
): Promise<ExternalImportPreview> {
  const wb = new ExcelJS.Workbook()
  // ExcelJS's Buffer type diverges from Node's generic Buffer<ArrayBufferLike>
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  const ws = wb.worksheets[0]
  if (!ws) {
    return {
      layout: 'vertical', columnMapping: emptyMapping(), weeks: 0, days: 0,
      exerciseCount: 0, exercises: [], warnings: [], errors: ['No worksheet found in the uploaded file.'],
      suggestedFocus: null, layoutTemplate: null,
      headerRowIndex: 0, headerCells: [], columnCount: 0,
    }
  }

  const maxCol = Math.max(ws.columnCount || 0, 1)
  const maxRow = ws.rowCount || 0
  const readRow = makeReadRow(ws, maxCol)

  const banner = findWeekBannerRow(readRow, maxRow)
  const dispatch = (): { layout: ExternalImportPreview['layout'] } & ParseResult => {
    if (banner) {
      const blockStarts = detectBlockGridStarts(readRow, banner)
      if (blockStarts) {
        return { layout: 'block-grid', ...parseBlockGrid(readRow, maxRow, banner, blockStarts) }
      }
      const weekGrid = detectWeekGrid(readRow, maxRow, banner)
      if (weekGrid) {
        return { layout: 'week-grid', ...parseWeekGrid(readRow, maxRow, banner, weekGrid.blockStarts, weekGrid.headerRow) }
      }
      return { layout: 'horizontal', ...parseHorizontal(readRow, maxRow, banner) }
    }
    return { layout: 'vertical', ...parseVertical(readRow, maxRow) }
  }

  // A manual override describes a simple stacked table, so force the vertical
  // parser with the override rather than re-running layout auto-detection.
  const result = hasParseOverride(overrides)
    ? { layout: 'vertical' as const, ...parseVertical(readRow, maxRow, overrides) }
    : dispatch()

  // Style capture reads cells located via the (possibly overridden) header row +
  // column mapping, so a manual remap re-points the fingerprint too.
  const layoutTemplate = result.exercises.length > 0
    ? captureLayoutTemplate(ws, {
        orientation: result.layout,
        columnMapping: result.columnMapping,
        exercises: result.exercises,
        headerRow: result.headerRow,
        bannerRow: banner?.row ?? null,
        bannerCol: banner?.weekCols[0] ?? null,
      })
    : null
  const headerRowIndex = result.headerRow ?? 0
  const headerCells = headerRowIndex > 0 ? readRow(headerRowIndex) : []
  const { headerRow: _omit, ...preview } = result
  void _omit
  return {
    ...preview,
    suggestedFocus: guessFocus(result.exercises),
    layoutTemplate,
    headerRowIndex,
    headerCells,
    columnCount: maxCol,
  }
}

// ---------------------------------------------------------------------------
// Vertical layout — weeks/days are section-header ROWS stacked top-to-bottom.
// ---------------------------------------------------------------------------
function parseVertical(readRow: ReadRow, maxRow: number, overrides?: ExternalParseOverrides): ParseResult {
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

const DAY_LABEL = /^day\s*(\d+)/i

/**
 * A block-grid sheet is a week-banner sheet whose blocks each begin with a
 * "DAY n" column one to the LEFT of the "Week n" banner. Returns the 1-based
 * block-start columns when the majority of weeks show that DAY-then-Week shape.
 */
function detectBlockGridStarts(readRow: ReadRow, banner: { row: number; weekCols: number[] }): number[] | null {
  const cells = readRow(banner.row)
  const starts: number[] = []
  let dayHits = 0
  for (const wc of banner.weekCols) {
    const left = (cells[wc - 2] ?? '').trim() // cell immediately left of the banner
    if (DAY_LABEL.test(left)) {
      starts.push(wc - 1)
      dayHits++
    } else {
      starts.push(wc)
    }
  }
  return dayHits >= Math.ceil(banner.weekCols.length / 2) ? starts : null
}

interface GridFields {
  name: number | null   // offsets relative to a block's start column
  sets: number | null
  reps: number | null
  load: number | null
  rpe: number | null
  erpe: number | null   // executed RPE — ignored on import, but tracked so the
                        // re-fill engine can clear stale executed values
  rpeFromRir: boolean
}

function resolveGridFields(headerCells: string[], blockStart: number, blockWidth: number): GridFields {
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
function normalizeBlockRpe(
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

function parseBlockGrid(
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

/**
 * A week-grid sheet is a week-banner sheet (not block-grid) whose data columns
 * begin AT each "Week N" banner — the cell on the banner column is a "Set"
 * header — with a non-name lead column one to the left holding day/movement
 * labels. Returns the lead-column block starts and the single header row.
 *
 * The lead column header must NOT be an exercise-name alias: that shape is the
 * horizontal "shared name column" layout (a dedicated "Discipline" column left
 * of the blocks), which parseHorizontal already handles.
 */
function detectWeekGrid(
  readRow: ReadRow,
  maxRow: number,
  banner: { row: number; weekCols: number[] },
): { blockStarts: number[]; headerRow: number } | null {
  if (banner.weekCols[0] < 2) return null // no room for a lead column
  const blockStarts = banner.weekCols.map((c) => c - 1)
  const blockWidth = blockStarts.length >= 2 ? blockStarts[1] - blockStarts[0] : 8
  const limit = Math.min(maxRow, banner.row + 8)
  for (let r = banner.row; r <= limit; r++) {
    const cells = readRow(r)
    const atBanner = tokenize(cells[banner.weekCols[0] - 1] ?? '')
    // A dedicated exercise-name column (e.g. "Discipline") at OR to the left of
    // the lead column is the signature of the horizontal "shared name column"
    // layout, which parseHorizontal already handles. A real week-grid has no
    // separate name column — its lead column holds the movement names under a
    // weekday header — so bail out and let the horizontal parser run instead.
    let hasNameColumn = false
    for (let c = 0; c < blockStarts[0]; c++) {
      if (tokenize(cells[c] ?? '').some((t) => ALIASES.exercise.includes(t))) { hasNameColumn = true; break }
    }
    if (hasNameColumn) return null
    const block = cells.slice(blockStarts[0] - 1, blockStarts[0] - 1 + blockWidth).join(' ').toLowerCase()
    if (atBanner.some((t) => t === 'set' || t === 'sets') && /\brep/.test(block)) {
      return { blockStarts, headerRow: r }
    }
  }
  return null
}

function parseWeekGrid(
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
  meta: {
    athleteId: string
    name: string
    status: string
    startDate?: string | null
    weeks: number
    focus?: string | null
    exportLayout?: ExportLayoutTemplate | null
    templateXlsx?: string | null   // base64 of the original file, for re-fill export
  },
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
        focus: meta.focus ?? null,
        export_layout: meta.exportLayout ? JSON.stringify(meta.exportLayout) : null,
        export_template_xlsx: meta.templateXlsx ?? null,
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
