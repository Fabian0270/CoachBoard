import type ExcelJS from 'exceljs'
import type {
  ExternalColumnMapping,
  ExternalImportPreview,
  ExternalParseOverrides,
} from 'coachboard-shared'
import { cellToString } from './cellParsing.js'

// ---------------------------------------------------------------------------
// Shared parser primitives — the row reader, the internal parse-result shape,
// and the small override/empty-mapping helpers used across all layout parsers.
// ---------------------------------------------------------------------------

export type ReadRow = (r: number) => string[]

// The internal parse result also carries `headerRow` — the worksheet row whose
// cells hold the column-header labels — so the style capture can sample fonts,
// colors and header wording from a known location. Not part of the public preview.
// headerRowIndex/headerCells/columnCount are derived once in parseExternalFile,
// not by the individual layout parsers, so they're omitted here.
export type ParseResult = Omit<
  ExternalImportPreview,
  'layout' | 'suggestedFocus' | 'layoutTemplate' | 'headerRowIndex' | 'headerCells' | 'columnCount'
> & {
  headerRow?: number
}

export const emptyMapping = (): ExternalColumnMapping =>
  ({ exercise: null, sets: null, reps: null, load: null, rpe: null, rpeFromRir: false })

export function makeReadRow(ws: ExcelJS.Worksheet, maxCol: number): ReadRow {
  return (r) => {
    const out: string[] = []
    for (let c = 1; c <= maxCol; c++) out.push(cellToString(ws.getCell(r, c).value))
    return out
  }
}

// True when the coach supplied any manual override (forces the vertical parser).
export function hasParseOverride(o?: ExternalParseOverrides): boolean {
  return !!o && (
    o.headerRow !== undefined || o.rpeFromRir !== undefined ||
    o.exercise !== undefined || o.sets !== undefined || o.reps !== undefined ||
    o.load !== undefined || o.rpe !== undefined
  )
}
