import { beforeAll, describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { initializeDatabase } from '../db.js'
import { createAthlete } from './athleteService.js'
import { parseExternalFile, commitExternalProgram } from './externalImportService.js'
import { buildProgramWorkbook } from './programExport.js'
import { parseImportFile } from './importService.js'
import { getProgramReport } from './analysisService.js'

// A coach's own sheet, end to end: import it, export it in the coach's style,
// and send the untouched export back through "Import results".
//
// Load Used and Last Set RPE are only ever what the athlete wrote. The coach's
// plain "Load" and "RPE" columns are the prescription, so they must come back
// out of the export, and must never be read back in as logged sets.

type Cell = string | number | null

async function coachSheet(): Promise<Buffer> {
  const rows: Cell[][] = [
    ['Exercise', 'Sets', 'Reps', 'Load', 'RPE'],
    ['Week 1'],
    ['Monday'],
    ['Squat', 3, 5, 100, 8],
    ['Bench Press', 3, 5, '75%', 7],
  ]
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Program')
  rows.forEach((row, r) => row.forEach((v, c) => { if (v !== null) ws.getCell(r + 1, c + 1).value = v }))
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer)
}

/** Load and RPE cells of the row naming `exercise`, read from columns D and E. */
function rowValues(ws: ExcelJS.Worksheet, exercise: string): { load: string; rpe: string } {
  for (let r = 1; r <= ws.rowCount; r++) {
    if (String(ws.getCell(r, 1).value ?? '').trim() === exercise) {
      return { load: String(ws.getCell(r, 4).value ?? ''), rpe: String(ws.getCell(r, 5).value ?? '') }
    }
  }
  throw new Error(`${exercise} not found in the export`)
}

let programId = ''
let exported: Buffer

beforeAll(async () => {
  await initializeDatabase(':memory:')
  const athlete = await createAthlete({ name: 'Prescription Athlete' })
  const buf = await coachSheet()
  const preview = await parseExternalFile(buf)
  expect(preview.errors).toEqual([])
  const result = await commitExternalProgram(preview.exercises, {
    athleteId: athlete.id,
    name: 'Coach Sheet',
    status: 'active',
    startDate: '2026-06-15',
    weeks: preview.weeks,
    exportLayout: preview.layoutTemplate,
    templateXlsx: buf.toString('base64'),
  })
  programId = result.programId
  const built = await buildProgramWorkbook(programId)
  exported = built.buffer
})

describe("a coach's own sheet", () => {
  it('is not reported as trained the moment it is imported', async () => {
    const report = await getProgramReport(programId)
    expect(report!.exercisesCompleted).toBe(0)
  })

  it("exports with the coach's prescription back in the coach's columns", async () => {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(exported as unknown as ArrayBuffer)
    const ws = wb.worksheets[0]
    expect(rowValues(ws, 'Squat')).toEqual({ load: '100', rpe: '8' })
    expect(rowValues(ws, 'Bench Press')).toEqual({ load: '75%', rpe: '7' })
  })

  /** A returned sheet in the shape "Import results" reads: day name beside the headers. */
  async function returnedSheet(loadHeader: string, rpeHeader: string): Promise<Buffer> {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Returned')
    ;['Monday', 'Exercise', 'Sets', 'Reps', loadHeader, rpeHeader].forEach((h, i) => { ws.getCell(1, i + 1).value = h })
    ;[['Squat', 3, 5, 100, 8], ['Bench Press', 3, 5, 80, 7]].forEach((row, r) =>
      row.forEach((v, c) => { ws.getCell(r + 2, c + 2).value = v }),
    )
    return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer)
  }

  it("sent back with the coach's plain Load / RPE columns, is not read as logged sets", async () => {
    // "Import results" used to take a plain "Load" column for the athlete's
    // Load Used, so every prescribed weight came back as a lift.
    const preview = await parseImportFile(await returnedSheet('Load', 'RPE'), programId)
    expect(preview.matched).toEqual([])
    expect(preview.errors.length).toBeGreaterThan(0)
  })

  it("sent back with the athlete's own columns, is read", async () => {
    const preview = await parseImportFile(await returnedSheet('Load used', 'Last set RPE'), programId)
    expect(preview.errors).toEqual([])
    expect(preview.matched.map((m) => [m.exerciseName, m.load_used, m.rpe])).toEqual([
      ['Squat', '100', '8'],
      ['Bench Press', '80', '7'],
    ])
  })
})
