import ExcelJS from 'exceljs'
import { WEEKDAY_NAMES } from 'coachboard-shared/exportLayout'

// ---------------------------------------------------------------------------
// Structural reader for a returned results sheet.
//
// The importer used to locate cells by replaying the exporter's offset maths.
// That only works for one shape: a coach's captured style may share a single
// exercise-name column across every week, start below a title block, or use its
// own header wording — and then every computed offset is wrong.
//
// This finds the tracking columns the way a person does: locate each day's
// header row, read which column carries "Load Used" for each week, and walk the
// rows beneath it. Nothing here assumes a column count, a stride, or a start row.
// ---------------------------------------------------------------------------

/** Cell → plain text, unwrapping the shapes ExcelJS uses for formulas and rich text. */
export function cellText(ws: ExcelJS.Worksheet, row: number, col: number): string {
  const v = ws.getCell(row, col).value
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>
    if ('result' in o) return o.result === null || o.result === undefined ? '' : String(o.result)
    if ('richText' in o) {
      return (o.richText as Array<{ text: string }>).map((t) => t.text).join('')
    }
    if ('text' in o) return String(o.text)
    return ''
  }
  return String(v)
}

/** Lowercase, strip punctuation, collapse whitespace — "Rest Time(mins)" → "rest time mins". */
function normalizeLabel(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9åäö]+/gi, ' ').trim()
}

// Header wording varies by coach style, so match a small alias set rather than
// the exact COLUMN_LABELS strings. Kept deliberately tight: "load" must not also
// match "load cap", which is a prescription column, not a result.
const NAME_LABELS = new Set(['discipline', 'exercise', 'movement', 'lift', 'name', 'övning', 'ovning'])
const LOAD_LABELS = new Set(['load used', 'load', 'weight used', 'vikt', 'belastning'])
const RPE_LABELS = new Set(['last set rpe', 'rpe', 'effort', 'rir'])

const DAY_LOOKUP: ReadonlyMap<string, number> = new Map(
  [...WEEKDAY_NAMES.en, ...WEEKDAY_NAMES.sv].map((name, i) => [
    normalizeLabel(name),
    i % 7,
  ]),
)

/** "Monday" / "Måndag" / "Day 3" → 0-based day index, or null. */
function dayIndexFrom(text: string): number | null {
  const norm = normalizeLabel(text)
  if (!norm) return null
  const named = DAY_LOOKUP.get(norm)
  if (named !== undefined) return named
  const dayN = norm.match(/^day\s*(\d+)$/) ?? norm.match(/^dag\s*(\d+)$/)
  if (dayN) {
    const n = parseInt(dayN[1], 10)
    if (n >= 1 && n <= 7) return n - 1
  }
  return null
}

export interface ResultsBlock {
  dayOfWeek: number
  headerRow: number
  /** One entry per week, or a single shared column used by every week. */
  nameCols: number[]
  /** Column carrying each week's "Load Used"; index = week. Empty if absent. */
  loadCols: number[]
  rpeCols: number[]
  /** Sheet rows holding this day's exercises, in order. */
  bodyRows: number[]
}

/** The name column a given week reads from — per-week when repeated, else shared. */
export function nameColForWeek(block: ResultsBlock, weekIndex: number): number | null {
  if (block.nameCols.length === 0) return null
  if (block.nameCols.length === 1) return block.nameCols[0]
  return block.nameCols[weekIndex] ?? null
}

interface HeaderScan {
  row: number
  nameCols: number[]
  loadCols: number[]
  rpeCols: number[]
  firstLabelCol: number
}

function scanHeaderRow(ws: ExcelJS.Worksheet, row: number, maxCol: number): HeaderScan | null {
  const nameCols: number[] = []
  const loadCols: number[] = []
  const rpeCols: number[] = []

  for (let c = 1; c <= maxCol; c++) {
    const norm = normalizeLabel(cellText(ws, row, c))
    if (!norm) continue
    if (NAME_LABELS.has(norm)) nameCols.push(c)
    else if (LOAD_LABELS.has(norm)) loadCols.push(c)
    else if (RPE_LABELS.has(norm)) rpeCols.push(c)
  }

  // A header row names the exercise column AND at least one result column;
  // anything less is a banner or a stray label sitting in the data.
  if (nameCols.length === 0) return null
  if (loadCols.length === 0 && rpeCols.length === 0) return null

  const firstLabelCol = Math.min(...nameCols, ...loadCols, ...rpeCols)
  return { row, nameCols, loadCols, rpeCols, firstLabelCol }
}

/**
 * Locate every day block in a returned results sheet.
 *
 * Returns an empty array when the sheet carries no recognisable headers — the
 * caller then falls back to replaying the export geometry.
 */
export function findResultsBlocks(ws: ExcelJS.Worksheet): ResultsBlock[] {
  const maxRow = ws.rowCount || 0
  const maxCol = ws.columnCount || 0
  if (maxRow === 0 || maxCol === 0) return []

  const headers = new Map<number, HeaderScan>()
  for (let r = 1; r <= maxRow; r++) {
    const scan = scanHeaderRow(ws, r, maxCol)
    if (scan) headers.set(r, scan)
  }
  if (headers.size === 0) return []

  const blocks: ResultsBlock[] = []
  for (const scan of headers.values()) {
    // The day label sits left of the first column header ("Monday" in column 1).
    let dayOfWeek: number | null = null
    for (let c = 1; c < scan.firstLabelCol; c++) {
      dayOfWeek = dayIndexFrom(cellText(ws, scan.row, c))
      if (dayOfWeek !== null) break
    }
    if (dayOfWeek === null) continue

    // Body rows run until the next header or the blank row separating days. The
    // span is checked across the whole block, not just the tracking columns: a
    // multi-set sub-row can be blank in both while still being a real row, and
    // treating it as the end would misalign everything after it.
    const bodyRows: number[] = []
    for (let r = scan.row + 1; r <= maxRow; r++) {
      if (headers.has(r)) break
      let hasContent = false
      for (let c = scan.firstLabelCol; c <= maxCol; c++) {
        if (cellText(ws, r, c).trim() !== '') { hasContent = true; break }
      }
      if (!hasContent) break
      bodyRows.push(r)
    }

    blocks.push({
      dayOfWeek,
      headerRow: scan.row,
      nameCols: scan.nameCols,
      loadCols: scan.loadCols,
      rpeCols: scan.rpeCols,
      bodyRows,
    })
  }

  return blocks
}
