import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { renderProgramWorkbook } from './exportService.js'
import type { ExportLayoutTemplate } from 'coachboard-shared'

// One Monday workout in a 1-week program. 2026-01-05 is a Monday.
const START = '2026-01-05'
const END = '2026-01-11'

const exercise = {
  name: 'Squat', sets: '3', reps: '5', weight: null as number | null,
  rest_time: null as string | null, intensity: null as string | null,
  load_used: null as string | null, rpe: '8' as string | null,
  group_id: null as string | null, order_index: 0, workout_id: 'w1',
}
const workouts = [{ id: 'w1', scheduled_date: START }]

function program(export_layout: string | null, enabled_columns: string | null = null) {
  return { name: 'Test Program', start_date: START, end_date: END, enabled_columns, export_layout }
}

async function loadFirstSheet(buf: Buffer): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as unknown as ArrayBuffer)
  return wb.worksheets[0]
}
const fillArgb = (ws: ExcelJS.Worksheet, r: number, c: number) =>
  (ws.getCell(r, c).fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb

describe('renderProgramWorkbook — templated (horizontal)', () => {
  const template: ExportLayoutTemplate = {
    version: 1,
    orientation: 'horizontal',
    columns: [
      { key: 'name', label: 'Movement' },
      { key: 'sets', label: 'Set' },
      { key: 'reps', label: 'Reps' },
      { key: 'load_used', label: 'Load' },
      { key: 'rpe', label: 'RPE' },
    ],
    dayLabels: { style: 'weekday', language: 'sv', custom: ['Måndag'] },
    rpeNotation: 'at',
    colors: {
      weekBanner: 'FFAA0000', dayHeader: 'FFAA0000',
      columnHeader: 'FF0000BB', trackingHeader: 'FF00BB00', body: null,
    },
    fonts: { headerBold: true, headerItalic: false, nameBold: true },
  }

  it("replays the coach's colors, day labels, header wording and @-RPE", async () => {
    const buf = await renderProgramWorkbook(program(JSON.stringify(template)), workouts, [exercise])
    const ws = await loadFirstSheet(buf)

    // Week banner at (row 1, col 2) in the coach's banner color.
    expect(ws.getCell(1, 2).value).toBe('Week 1')
    expect(fillArgb(ws, 1, 2)).toBe('FFAA0000')

    // Day label uses the captured Swedish weekday.
    expect(ws.getCell(2, 1).value).toBe('Måndag')

    // Header wording + tracking color come from the template.
    expect(ws.getCell(2, 2).value).toBe('Movement')
    expect(fillArgb(ws, 2, 2)).toBe('FF0000BB')
    expect(ws.getCell(2, 6).value).toBe('RPE')
    expect(fillArgb(ws, 2, 6)).toBe('FF00BB00')

    // Body row: name + @-prefixed RPE.
    expect(ws.getCell(3, 2).value).toBe('Squat')
    expect(ws.getCell(3, 6).value).toBe('@8')
  })
})

describe('renderProgramWorkbook — templated (vertical)', () => {
  const template: ExportLayoutTemplate = {
    version: 1,
    orientation: 'vertical',
    columns: [
      { key: 'name', label: 'Exercise' },
      { key: 'sets', label: 'Sets' },
      { key: 'reps', label: 'Reps' },
      { key: 'rpe', label: 'RPE' },
    ],
    dayLabels: { style: 'weekday', language: 'en' },
    rpeNotation: 'plain',
    colors: { weekBanner: null, dayHeader: null, columnHeader: null, trackingHeader: null, body: null },
    fonts: { headerBold: true, headerItalic: true, nameBold: true },
  }

  it('stacks a single column set with week/day section rows', async () => {
    const buf = await renderProgramWorkbook(program(JSON.stringify(template)), workouts, [exercise])
    const ws = await loadFirstSheet(buf)
    // Top header row, then "Week 1", "Monday", then the exercise.
    expect(ws.getCell(1, 1).value).toBe('Exercise')
    // Scan column 1 for the week + day section labels.
    const colA: string[] = []
    ws.getColumn(1).eachCell((cell) => colA.push(String(cell.value ?? '')))
    expect(colA).toContain('Week 1')
    expect(colA).toContain('Monday')
    expect(colA).toContain('Squat')
  })
})

describe('renderProgramWorkbook — generic (no template)', () => {
  it('falls back to CoachBoard defaults driven by enabled_columns', async () => {
    const buf = await renderProgramWorkbook(program(null, JSON.stringify(['load_used', 'rpe'])), workouts, [exercise])
    const ws = await loadFirstSheet(buf)
    // Default header wording + Monday day label.
    expect(ws.getCell(1, 2).value).toBe('Week 1')
    expect(ws.getCell(2, 1).value).toBe('Monday')
    expect(ws.getCell(2, 2).value).toBe('Discipline')
    // load_cap/intensity were NOT enabled → not present in the header row.
    const headerRow: string[] = []
    ws.getRow(2).eachCell((cell) => headerRow.push(String(cell.value ?? '')))
    expect(headerRow).not.toContain('Load Cap')
    expect(headerRow).toContain('Last Set RPE')
  })
})
