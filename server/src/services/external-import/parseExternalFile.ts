import ExcelJS from 'exceljs'
import type { ExternalImportPreview, ExternalParseOverrides } from 'coachboard-shared'
import { emptyMapping, makeReadRow, hasParseOverride, type ParseResult } from './shared.js'
import { findWeekBannerRow, detectBlockGridStarts, detectWeekGrid } from './layoutDetection.js'
import { parseVertical } from './parsers/verticalParser.js'
import { parseHorizontal } from './parsers/horizontalParser.js'
import { parseBlockGrid } from './parsers/blockGridParser.js'
import { parseWeekGrid } from './parsers/weekGridParser.js'
import { captureLayoutTemplate } from './layoutCapture.js'
import { guessFocus } from './focus.js'

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
