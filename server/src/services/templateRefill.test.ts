import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { refillTemplate } from './templateRefillService.js'

const FORM_URL = 'https://docs.google.com/forms/d/e/EXAMPLE/viewform'

// Build a 2-week, 1-day block-grid sheet (the "thickbeck" shape) with a working
// hyperlink + a merged decorative cell, so we can prove re-fill preserves them.
// Block width 7: Movement(0) SETS(1) REPS(2) LOAD(3) RPE(4) eRPE(5) + gap.
// Week 0 block starts at col 2, week 1 at col 9.
async function buildTemplate(): Promise<string> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Block 1')

  // Decorative + hyperlink header region (rows 1-2 of column A area).
  ws.getCell('A1').value = 'Microcycle'
  ws.mergeCells('A1:A2')
  ws.getCell('F1').value = { text: 'Block Färdigt Klicka här', hyperlink: FORM_URL }

  // Banner row (row 4): DAY 1 + Week n per block.
  ws.getCell(4, 2).value = 'DAY 1'
  ws.getCell(4, 3).value = 'Week 1'
  ws.getCell(4, 9).value = 'DAY 1'
  ws.getCell(4, 10).value = 'Week 2'
  // Header row (row 5).
  const cols = ['Movement', 'SETS', 'REPS', 'LOAD', 'RPE', 'eRPE']
  cols.forEach((c, i) => { ws.getCell(5, 2 + i).value = c; ws.getCell(5, 9 + i).value = c })
  // Data row (row 6): Squat with old prescription + executed eRPE.
  const w0 = ['Squat', 1, 3, 180, '@6', 6]
  const w1 = ['Squat', 1, 3, 185, '@6-7', 5]
  w0.forEach((v, i) => { ws.getCell(6, 2 + i).value = v })
  w1.forEach((v, i) => { ws.getCell(6, 9 + i).value = v })

  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer).toString('base64')
}

const program = { start_date: '2026-01-05' } // a Monday
const workouts = [{ id: 'w1', scheduled_date: '2026-01-05' }] // week 0, day 0
const newSquat = {
  name: 'Squat', sets: '5', reps: '2', weight: 200, intensity: null,
  load_used: null, rpe: '8', order_index: 0, workout_id: 'w1',
}

async function loadSheet(buf: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as unknown as ArrayBuffer)
  return wb.worksheets[0]
}

describe('refillTemplate', () => {
  it('overwrites matched data cells while preserving the hyperlink, merges and eRPE clearing', async () => {
    const template = await buildTemplate()
    const out = await refillTemplate(template, program, workouts, [newSquat])
    expect(out).not.toBeNull()
    const ws = await loadSheet(out!)

    // Hyperlink to the coach's form survives untouched.
    const linkCell = ws.getCell('F1')
    const link = linkCell.hyperlink ?? (typeof linkCell.value === 'object' ? (linkCell.value as { hyperlink?: string }).hyperlink : undefined)
    expect(link).toBe(FORM_URL)
    // Decorative merge survives.
    expect(ws.getCell('A1').value).toBe('Microcycle')

    // Week 0 (matched) data cells re-filled with the new prescription.
    expect(ws.getCell(6, 3).value).toBe('5')    // SETS
    expect(ws.getCell(6, 4).value).toBe('2')    // REPS
    expect(ws.getCell(6, 5).value).toBe(200)    // LOAD
    expect(ws.getCell(6, 6).value).toBe('@8')   // RPE — @ notation matched from template
    expect(ws.getCell(6, 7).value).toBeNull()   // eRPE cleared (executed data)

    // Week 1 had no matching new-program block → left exactly as the template was.
    expect(ws.getCell(6, 12).value).toBe(185)   // LOAD
    expect(ws.getCell(6, 13).value).toBe('@6-7')
  })

  it('returns null when nothing lines up (caller falls back to the renderer)', async () => {
    const template = await buildTemplate()
    expect(await refillTemplate(template, program, workouts, [])).toBeNull()
    // A program with no start date can't be located either.
    expect(await refillTemplate(template, { start_date: null }, workouts, [newSquat])).toBeNull()
  })
})
