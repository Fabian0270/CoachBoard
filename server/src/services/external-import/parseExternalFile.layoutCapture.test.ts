import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { parseExternalFile } from '../externalImportService.js'
import { buildWeekGridSheet, WG_PROGRAM } from './__testutils__/buildSheet.js'

// ---------------------------------------------------------------------------
// Layout template capture — the "fingerprint" persisted so derived programs
// re-export in the coach's own style.
// ---------------------------------------------------------------------------
describe('parseExternalFile — layout template capture', () => {
  it('captures orientation, columns, Swedish day labels and @-RPE notation', async () => {
    const res = await parseExternalFile(await buildWeekGridSheet(2, WG_PROGRAM))
    const t = res.layoutTemplate!
    expect(t).not.toBeNull()
    expect(t.version).toBe(1)
    expect(t.orientation).toBe('week-grid')
    expect(t.rpeNotation).toBe('at')          // source RPE cells were "@6" / "@7"
    expect(t.dayLabels.language).toBe('sv')   // Tisdag / Torsdag
    expect(t.dayLabels.style).toBe('weekday')
    expect(t.dayLabels.custom?.[1]).toBe('Tisdag')
    expect(t.dayLabels.custom?.[3]).toBe('Torsdag')
    // Column keys mapped from the external mapping, with the coach's own wording.
    expect(t.columns.map((c) => c.key)).toEqual(['name', 'sets', 'reps', 'load_used', 'rpe'])
    const byKey = Object.fromEntries(t.columns.map((c) => [c.key, c.label]))
    expect(byKey.sets).toBe('Set')
    expect(byKey.reps).toBe('Reps')
    expect(byKey.load_used).toBe('Load')
    expect(byKey.rpe).toBe('RPE')
  })

  it('captures fill colors and header fonts from a styled horizontal sheet', async () => {
    // Build a styled horizontal sheet directly so cell fills/fonts exist. Two
    // side-by-side week blocks (block width 6) are needed for the horizontal
    // layout to be detected; block 1 starts at col 2, block 2 at col 8.
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Sheet1')
    const fill = (argb: string) => ({ type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb } })
    const headers = ['Discipline', 'Sets', 'Reps', 'Load Used', 'RPE']
    // Row 1: week banners on each block's first column (cols 2 and 8).
    ws.getCell(1, 2).value = 'Week 1'
    ws.getCell(1, 2).fill = fill('FFAA0000')
    ws.getCell(1, 8).value = 'Week 2'
    // Row 2: day label (col 1) + column headers for both blocks.
    ws.getCell(2, 1).value = 'Monday'
    headers.forEach((h, i) => {
      const cell = ws.getCell(2, 2 + i)
      cell.value = h
      cell.fill = fill(i >= 3 ? 'FF00BB00' : 'FF0000BB') // tracking vs normal header
      cell.font = { bold: true, italic: true }
      ws.getCell(2, 8 + i).value = h // block 2 headers (unstyled)
    })
    // Row 3: one exercise row in each block.
    const body = ['Squat', 3, 5, 100, 8]
    body.forEach((v, i) => { ws.getCell(3, 2 + i).value = v; ws.getCell(3, 8 + i).value = v })
    ws.getCell(3, 2).font = { bold: true }
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer)

    const res = await parseExternalFile(buf)
    expect(res.layout).toBe('horizontal')
    const t = res.layoutTemplate!
    expect(t.orientation).toBe('horizontal')
    expect(t.colors.weekBanner).toBe('FFAA0000')
    expect(t.colors.columnHeader).toBe('FF0000BB')
    expect(t.colors.trackingHeader).toBe('FF00BB00')
    expect(t.fonts.headerBold).toBe(true)
    expect(t.fonts.headerItalic).toBe(true)
    expect(t.fonts.nameBold).toBe(true)
    expect(t.dayLabels.language).toBe('en')
    expect(t.dayLabels.custom?.[0]).toBe('Monday')
  })
})