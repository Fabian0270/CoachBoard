import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { sheetBounds, SheetTooLargeError, valueAt, MAX_SHEET_ROWS } from './sheetBounds.js'
import { parseExternalFile } from '../services/externalImportService.js'
import { renderWorkbookHtml } from '../services/programPreview.js'
import { findResultsBlocks } from '../services/resultsSheetLayout.js'

// The audit's crash file: a small program plus one stray cell far away. A 6 KB
// file shaped like this cost about 1 GB per read at row 100,000 and killed the
// process outright at row 300,000.

async function programWithStray(stray?: { row: number; col: number; styleOnly?: boolean }) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('S')
  ws.getCell('A1').value = 'Exercise'
  ws.getCell('B1').value = 'Sets'
  ws.getCell('C1').value = 'Reps'
  ws.getCell('A2').value = 'Squat'
  ws.getCell('B2').value = 3
  ws.getCell('C2').value = 5
  if (stray) {
    const cell = ws.getCell(stray.row, stray.col)
    if (stray.styleOnly) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } }
    else cell.value = 'x'
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

async function load(buffer: Buffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  return wb.worksheets[0]
}

describe('sheetBounds', () => {
  it('measures the content, not the furthest stored cell', async () => {
    const ws = await load(await programWithStray({ row: 50_000, col: 40, styleOnly: true }))
    // A formatted-but-empty cell is not content. Coaches format whole areas.
    expect(sheetBounds(ws)).toEqual({ rows: 2, cols: 3 })
  })

  it('refuses a stray value far below the program, saying where it is', async () => {
    const ws = await load(await programWithStray({ row: 300_000, col: 2 }))
    expect(() => sheetBounds(ws)).toThrow(SheetTooLargeError)
    expect(() => sheetBounds(ws)).toThrow(/cell B300000/)
  })

  it('reads without creating cells', async () => {
    const ws = await load(await programWithStray())
    expect(valueAt(ws, 5000, 50)).toBeNull()
    expect(ws.findCell(5000, 50)).toBeUndefined()
    expect(ws.rowCount).toBe(2)
  })
})

describe('every reader stays bounded', () => {
  const STRAY_ROW = 300_000

  it('external import refuses the crash file quickly', async () => {
    const started = Date.now()
    await expect(parseExternalFile(await programWithStray({ row: STRAY_ROW, col: 2 }))).rejects.toThrow(
      SheetTooLargeError,
    )
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('external import still reads a sheet with far-away formatting', async () => {
    const preview = await parseExternalFile(
      await programWithStray({ row: MAX_SHEET_ROWS * 5, col: 30, styleOnly: true }),
    )
    expect(preview.errors).toEqual([])
    expect(preview.exercises.map((e) => e.name)).toEqual(['Squat'])
  })

  it('the preview refuses rather than building a gigantic table', async () => {
    await expect(renderWorkbookHtml(await programWithStray({ row: STRAY_ROW, col: 2 }))).rejects.toThrow(
      SheetTooLargeError,
    )
  })

  it('the preview ignores far-away formatting', async () => {
    const html = await renderWorkbookHtml(await programWithStray({ row: 20_000, col: 30, styleOnly: true }))
    expect((html.match(/<tr>/g) ?? []).length).toBe(2)
  })

  it('the results importer refuses the crash file', async () => {
    const ws = await load(await programWithStray({ row: STRAY_ROW, col: 2 }))
    expect(() => findResultsBlocks(ws)).toThrow(SheetTooLargeError)
  })
})
