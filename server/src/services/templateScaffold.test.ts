import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { renderScaffold } from './templateScaffoldService.js'

const FORM_URL = 'https://docs.google.com/forms/d/e/EXAMPLE/viewform'

// A 2-week block-grid template (the "thickbeck" shape) with chrome + a working
// hyperlink. Block width 7: Movement(0) SETS(1) REPS(2) LOAD(3) RPE(4) eRPE(5) +
// gap. Banner row 4 (chrome rows 1-3). Week 0 block at col 2, week 1 at col 9.
async function buildTemplate(): Promise<string> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Block 1')
  ws.getCell('A1').value = 'Microcycle'
  ws.mergeCells('A1:B1')
  ws.getCell('C2').value = { text: 'Block Färdigt Klicka här', hyperlink: FORM_URL }

  ws.getCell(4, 2).value = 'DAY 1'; ws.getCell(4, 3).value = 'Week 1'
  ws.getCell(4, 9).value = 'DAY 1'; ws.getCell(4, 10).value = 'Week 2'
  const cols = ['Movement', 'SETS', 'REPS', 'LOAD', 'RPE', 'eRPE']
  cols.forEach((c, i) => { ws.getCell(5, 2 + i).value = c; ws.getCell(5, 9 + i).value = c })
  ;['Squat', 1, 3, 180, '@6', 6].forEach((v, i) => { ws.getCell(6, 2 + i).value = v })
  ;['Squat', 1, 3, 185, '@6-7', 5].forEach((v, i) => { ws.getCell(6, 9 + i).value = v })
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer).toString('base64')
}

async function load(buf: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as unknown as ArrayBuffer)
  return wb.worksheets[0]
}

const program = { start_date: '2026-01-05' } // a Monday

describe('renderScaffold', () => {
  it('rebuilds a 1-week program in the style with the program\'s own movements and no source remnants', async () => {
    const template = await buildTemplate()
    const workouts = [{ id: 'd1', scheduled_date: '2026-01-05' }]
    const exercises = [
      { name: 'Front Squat', sets: '4', reps: '6', weight: 150, intensity: null, load_used: null, rpe: '7', order_index: 0, workout_id: 'd1' },
      { name: 'Pull-ups', sets: '3', reps: '10', weight: null, intensity: null, load_used: null, rpe: null, order_index: 1, workout_id: 'd1' },
    ]
    const out = await renderScaffold(template, program, workouts, exercises)
    expect(out).not.toBeNull()
    const ws = await load(out!)

    // Chrome + working form link preserved.
    expect(ws.getCell('A1').value).toBe('Microcycle')
    const link = ws.getCell('C2').value as { hyperlink?: string }
    expect(link.hyperlink).toBe(FORM_URL)

    // Exactly one week-block (the program is 1 week, the template was 2).
    const banners: string[] = []
    ws.eachRow((row) => row.eachCell((c) => { if (typeof c.value === 'string' && /^Week \d+$/.test(c.value)) banners.push(c.value) }))
    expect(banners).toEqual(['Week 1'])

    // No source movement leaked through.
    let sawSquat = false
    ws.eachRow((row) => row.eachCell((c) => { if (c.value === 'Squat') sawSquat = true }))
    expect(sawSquat).toBe(false)

    // The program's own movements, filled, with @-RPE and a blank eRPE column.
    expect(ws.getCell(6, 2).value).toBe('Front Squat')
    expect(ws.getCell(6, 5).value).toBe(150)   // LOAD
    expect(ws.getCell(6, 6).value).toBe('@7')  // RPE
    expect(ws.getCell(6, 7).value).toBeNull()  // eRPE blank
    expect(ws.getCell(7, 2).value).toBe('Pull-ups')
  })

  it('stamps as many week-blocks as the program has weeks', async () => {
    const template = await buildTemplate()
    const workouts = [
      { id: 'w1', scheduled_date: '2026-01-05' }, // week 0
      { id: 'w2', scheduled_date: '2026-01-12' }, // week 1
      { id: 'w3', scheduled_date: '2026-01-19' }, // week 2
    ]
    const mk = (id: string) => ({ name: 'Bench', sets: '3', reps: '5', weight: 100, intensity: null, load_used: null, rpe: '8', order_index: 0, workout_id: id })
    const out = await renderScaffold(template, program, workouts, [mk('w1'), mk('w2'), mk('w3')])
    const ws = await load(out!)
    const banners: string[] = []
    ws.eachRow((row) => row.eachCell((c) => { if (typeof c.value === 'string' && /^Week \d+$/.test(c.value)) banners.push(c.value) }))
    expect(banners).toEqual(['Week 1', 'Week 2', 'Week 3'])
  })

  it('returns null for an empty program (caller falls back to the renderer)', async () => {
    const template = await buildTemplate()
    expect(await renderScaffold(template, program, [], [])).toBeNull()
  })
})
