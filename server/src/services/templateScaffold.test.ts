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
  // Two movement rows per day so a 2-movement program maps onto the template.
  ;['Squat', 1, 3, 180, '@6', 6].forEach((v, i) => { ws.getCell(6, 2 + i).value = v })
  ;['Bench', 3, 8, 110, '@6', 6].forEach((v, i) => { ws.getCell(7, 2 + i).value = v })
  ;['Squat', 1, 3, 185, '@6-7', 5].forEach((v, i) => { ws.getCell(6, 9 + i).value = v })
  ;['Bench', 3, 8, 115, '@7', 7].forEach((v, i) => { ws.getCell(7, 9 + i).value = v })
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

  it('inserts rows when a day has more movements than the template (no overflow drop)', async () => {
    const template = await buildTemplate() // day 1 has 2 movement rows
    const workouts = [{ id: 'd1', scheduled_date: '2026-01-05' }]
    const names = ['A', 'B', 'C', 'D', 'E'] // five movements into a 2-row template
    const exercises = names.map((n, i) => ({
      name: n, sets: '3', reps: '5', weight: 100, intensity: null, load_used: null, rpe: '8', order_index: i, workout_id: 'd1',
    }))
    const ws = await load((await renderScaffold(template, program, workouts, exercises))!)
    const seen = new Set<string>()
    ws.eachRow((row) => row.eachCell((c) => { if (typeof c.value === 'string') seen.add(c.value) }))
    names.forEach((n) => expect(seen.has(n)).toBe(true))
  })
})

// A vertical (weeks-stacked) template with chrome + a hyperlink. Header row 3;
// week 1 rows 4-7, week 2 rows 8-11 (rowStride 4).
async function buildVertical(): Promise<string> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('V')
  ws.getCell('A1').value = 'My Program'
  ws.getCell('B1').value = { text: 'Form', hyperlink: FORM_URL }
  ;['Exercise', 'Sets', 'Reps', 'Load', 'RPE'].forEach((h, i) => { ws.getCell(3, 1 + i).value = h })
  ws.getCell(4, 1).value = 'Week 1'; ws.getCell(5, 1).value = 'Day 1'
  ;['Squat', 3, 5, 180, '@8'].forEach((v, i) => { ws.getCell(6, 1 + i).value = v })
  ws.getCell(8, 1).value = 'Week 2'; ws.getCell(9, 1).value = 'Day 1'
  ;['Squat', 3, 5, 185, '@8'].forEach((v, i) => { ws.getCell(10, 1 + i).value = v })
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer).toString('base64')
}

// A week-grid template whose day sections are weekday labels in the lead column
// (English/Swedish), with the header on the first day's row. Block width 8.
async function buildWeekdaySheet(): Promise<string> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('WD')
  const lead = (w: number) => 1 + w * 8
  ws.getCell(1, lead(0) + 1).value = 'Week 1'; ws.getCell(1, lead(1) + 1).value = 'Week 2'
  const head = ['Set', 'Reps', 'RPE', 'Load']
  // Day 1 = Tisdag shares the header row; Day 2 = Torsdag is a bare label row.
  // Week 1 uses weekday labels; week 2 is inconsistent ("Day 1"/"Day 2") — the
  // export should normalise it back to the week-1 wording.
  ;[0, 1].forEach((w) => {
    ws.getCell(2, lead(w)).value = w === 0 ? 'Tisdag' : 'Day 1'
    head.forEach((h, i) => { ws.getCell(2, lead(w) + 1 + i).value = h })
    ws.getCell(3, lead(w)).value = 'Squat'; ;[3, 5, '@6', 180].forEach((v, i) => { ws.getCell(3, lead(w) + 1 + i).value = v })
    ws.getCell(5, lead(w)).value = w === 0 ? 'Torsdag' : 'Day 2'
    ws.getCell(6, lead(w)).value = 'Bench'; ;[3, 8, '@7', 110].forEach((v, i) => { ws.getCell(6, lead(w) + 1 + i).value = v })
  })
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer).toString('base64')
}

describe('renderScaffold — weekday day-section labels', () => {
  it('keeps weekday section labels (Tisdag/Torsdag) instead of wiping them', async () => {
    const mv = (wid: string, name: string) =>
      ({ name, sets: '4', reps: '6', weight: 150, intensity: null, load_used: null, rpe: '7', order_index: 0, workout_id: wid })
    const out = await renderScaffold(await buildWeekdaySheet(), program,
      [ // two weeks, two days each (Tue + Thu)
        { id: 'a1', scheduled_date: '2026-01-06' }, { id: 'a2', scheduled_date: '2026-01-08' },
        { id: 'b1', scheduled_date: '2026-01-13' }, { id: 'b2', scheduled_date: '2026-01-15' },
      ],
      [mv('a1', 'Front Squat'), mv('a2', 'Incline Bench'), mv('b1', 'Front Squat'), mv('b2', 'Incline Bench')])
    const ws = await load(out!)
    const labels = new Set<string>()
    ws.eachRow((row) => row.eachCell((c) => { if (typeof c.value === 'string') labels.add(c.value) }))
    expect(labels.has('Tisdag')).toBe(true)
    expect(labels.has('Torsdag')).toBe(true)   // previously wiped — the bug this guards
    expect(labels.has('Front Squat')).toBe(true)
    expect(labels.has('Incline Bench')).toBe(true)
    expect(labels.has('Squat')).toBe(false)    // source movement gone
    // Week 2's inconsistent "Day 1"/"Day 2" labels are normalised away.
    expect(labels.has('Day 1')).toBe(false)
    expect(labels.has('Day 2')).toBe(false)
    // Both week blocks carry the week-1 weekday wording.
    expect(ws.getCell(2, 9).value).toBe('Tisdag')   // week 2 lead col, header row
    expect(ws.getCell(5, 9).value).toBe('Torsdag')  // week 2 lead col, day-2 row
  })
})

describe('renderScaffold — vertical (row-axis)', () => {
  it('rebuilds a vertical template: own movement, chrome + link, one week, no remnants', async () => {
    const out = await renderScaffold(await buildVertical(), program,
      [{ id: 'd1', scheduled_date: '2026-01-05' }],
      [{ name: 'Front Squat', sets: '4', reps: '6', weight: 150, intensity: null, load_used: null, rpe: '7', order_index: 0, workout_id: 'd1' }])
    expect(out).not.toBeNull()
    const ws = await load(out!)
    expect((ws.getCell('B1').value as { hyperlink?: string }).hyperlink).toBe(FORM_URL)
    const banners: string[] = []; let sawSquat = false; let sawFront = false
    ws.eachRow((row) => row.eachCell((c) => {
      if (typeof c.value === 'string') { if (/^Week \d+$/.test(c.value)) banners.push(c.value); if (c.value === 'Squat') sawSquat = true; if (c.value === 'Front Squat') sawFront = true }
    }))
    expect(banners).toEqual(['Week 1'])
    expect(sawSquat).toBe(false)
    expect(sawFront).toBe(true)
  })
})
