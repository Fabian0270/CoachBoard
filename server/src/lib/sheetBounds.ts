import type ExcelJS from 'exceljs'

// ---------------------------------------------------------------------------
// How much of a worksheet is worth reading.
//
// Every reader used to loop from 1 to `ws.rowCount` and `ws.columnCount`,
// calling `ws.getCell` on each position. Two things made that a crash:
//
//   - rowCount/columnCount are the furthest cell Excel ever STORED, content or
//     not, so one stray character at row 300,000 makes the sheet 300,000 rows;
//   - getCell CREATES every cell it is asked about, so the loop allocated the
//     whole grid as it walked it.
//
// Measured during the audit: a 6 KB file with one cell at row 100,000 cost
// 4-6 s and about 1 GB per read and produced 90 MB of preview HTML; at row
// 300,000 the process died with "heap out of memory". The server runs inside
// the Electron main process, so that took the whole app down — and a sheet an
// athlete sends back is exactly the kind of file that carries one.
//
// So: the extent is measured from cells that actually hold a value (a styled
// empty cell is not content), lookups use findCell, which never creates, and a
// sheet whose content reaches past the limits is refused with a message that
// says where the stray content is.
// ---------------------------------------------------------------------------

/**
 * Generous for any real program. The widest the app's own exporter produces is
 * a 52-week horizontal sheet: 1 + 52 x 8 columns + 51 gaps = 468 columns, by
 * a couple of hundred rows — about 100k cells.
 */
export const MAX_SHEET_ROWS = 10_000
export const MAX_SHEET_COLS = 1_000
export const MAX_SHEET_CELLS = 500_000

export class SheetTooLargeError extends Error {
  /** HTTP status for routes to answer with. */
  readonly status = 413
  constructor(message: string) {
    super(message)
    this.name = 'SheetTooLargeError'
  }
}

export interface SheetBounds {
  /** Last row holding a value, 0 for an empty sheet. */
  rows: number
  /** Last column holding a value, 0 for an empty sheet. */
  cols: number
}

const hasContent = (value: ExcelJS.CellValue): boolean =>
  value !== null && value !== undefined && value !== ''

/**
 * The extent of the sheet's CONTENT, refusing one too large to read.
 *
 * Walks only the cells ExcelJS has stored, so its cost is proportional to the
 * file rather than to how far away its furthest cell is.
 */
export function sheetBounds(ws: ExcelJS.Worksheet): SheetBounds {
  let rows = 0
  let cols = 0
  let furthestRow = ''
  let furthestCol = ''
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    row.eachCell({ includeEmpty: false }, (cell, c) => {
      if (!hasContent(cell.value)) return
      if (r > rows) {
        rows = r
        furthestRow = cell.address
      }
      if (c > cols) {
        cols = c
        furthestCol = cell.address
      }
    })
  })

  if (rows > MAX_SHEET_ROWS || cols > MAX_SHEET_COLS || rows * cols > MAX_SHEET_CELLS) {
    const where = rows > MAX_SHEET_ROWS || rows * cols > MAX_SHEET_CELLS ? furthestRow : furthestCol
    throw new SheetTooLargeError(
      `This sheet is too large to read: it has content as far out as cell ${where}. ` +
        `CoachBoard reads up to ${MAX_SHEET_ROWS.toLocaleString('en')} rows and ` +
        `${MAX_SHEET_COLS.toLocaleString('en')} columns. Something is usually stored far below ` +
        `or to the right of the program by accident — in Excel, Ctrl+End jumps to it. ` +
        `Delete it, save, and try again.`,
    )
  }
  return { rows, cols }
}

/** A cell's value without creating the cell. Null where nothing is stored. */
export function valueAt(ws: ExcelJS.Worksheet, row: number, col: number): ExcelJS.CellValue {
  return ws.findCell(row, col)?.value ?? null
}
