import { beforeAll, describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { DEFAULT_ENABLED_COLUMNS } from 'coachboard-shared'
import { initializeDatabase, getDb } from '../../db.js'
import { createAthlete } from '../athleteService.js'
import { createProgram, setProgramDuration, createWorkout, createExercise } from '../programService.js'
import { buildProgramWorkbook } from '../programExport.js'
import { parseExternalFile, commitExternalProgram } from '../externalImportService.js'
import { isCueHeader, resolveHeaderRow } from './headerDetection.js'
import { buildSheet, type Cell } from './__testutils__/buildSheet.js'

// ---------------------------------------------------------------------------
// A coach's own notes / comments column, brought in as the cue column (D7d).
//
// A sheet that carried cues comes in with the cue column on and the cues in
// it; a sheet without them comes in exactly as before. On the way back out the
// cues go into the sheet's own notes column, not after the name, and with the
// cue column off nothing of them is exported.
// ---------------------------------------------------------------------------

let athleteId: string
beforeAll(async () => {
  await initializeDatabase(':memory:')
  athleteId = (await createAthlete({ name: 'Import Athlete' })).id
})

async function sheetOf(buffer: Buffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  return wb.worksheets[0]
}
const text = (ws: ExcelJS.Worksheet, r: number, c: number) => {
  const v = ws.getCell(r, c).value
  return v === null || v === undefined ? '' : String(v).trim()
}
const allText = (ws: ExcelJS.Worksheet) => {
  const out: string[] = []
  for (let r = 1; r <= ws.rowCount; r++) for (let c = 1; c <= ws.columnCount; c++) out.push(text(ws, r, c))
  return out
}

async function commit(buffer: Buffer, name: string) {
  const preview = await parseExternalFile(buffer)
  expect(preview.errors).toEqual([])
  const { programId } = await commitExternalProgram(preview.exercises, {
    athleteId, name, status: 'active', startDate: '2026-06-08', weeks: preview.weeks,
    exportLayout: preview.layoutTemplate ?? null, templateXlsx: buffer.toString('base64'),
  })
  const db = getDb()
  const program = await db.selectFrom('programs').selectAll().where('id', '=', programId).executeTakeFirstOrThrow()
  const exercises = await db.selectFrom('exercises').innerJoin('workouts', 'workouts.id', 'exercises.workout_id')
    .select(['exercises.name', 'exercises.notes']).where('workouts.program_id', '=', programId)
    .orderBy('workouts.scheduled_date').orderBy('exercises.order_index').execute()
  return { programId, program, exercises, preview }
}

const setCues = (programId: string, on: boolean) =>
  getDb().updateTable('programs')
    .set({ enabled_columns: JSON.stringify([...DEFAULT_ENABLED_COLUMNS, ...(on ? ['notes'] : [])]) })
    .where('id', '=', programId).execute()

// A plain stacked sheet with a Comments column, as coaches write them.
const COMMENTED: Cell[][] = [
  ['Exercise', 'Sets', 'Reps', 'Load', 'RPE', 'Comments'],
  ['Week 1'],
  ['Day 1'],
  ['Squat', 3, 5, 100, 8, 'pause 2 s at the bottom'],
  ['Bench Press', 3, 8, 80, 7, null],
  ['Barbell Row', 3, 10, 60, 7, 'strict, no hip drive'],
]

describe('which header is a cue column', () => {
  it('takes the coach’s notes, comments and cues, in English and Swedish', () => {
    for (const h of ['Notes', 'Note', 'Comments', 'Coach comments', 'Cues', 'Coaching cue', 'Instructions', 'Kommentar', 'Kommentarer', 'Anteckningar', 'Instruktioner']) {
      expect(isCueHeader(h), h).toBe(true)
    }
  })

  it('never takes a column the athlete writes in', () => {
    for (const h of ['Athlete comments', 'Comments after session', 'Feedback', 'Actual notes', 'Atletens kommentar', 'Kommentar efter passet', 'Exercise', 'RPE']) {
      expect(isCueHeader(h), h).toBe(false)
    }
  })

  it('finds the column but does not let it count toward choosing the header row', () => {
    const { mapping, matchCount } = resolveHeaderRow(['Exercise', 'Sets', 'Reps', 'Notes'])
    expect(mapping.notes).toBe(4)
    expect(matchCount).toBe(3)
    // A free-text row that only says "Notes" is no header row.
    expect(resolveHeaderRow(['Notes', '', '']).matchCount).toBe(0)
  })

  it('leaves a field whose header also says "notes" as that field', () => {
    const { mapping } = resolveHeaderRow(['Exercise', 'Sets', 'Reps', 'Load notes'])
    expect(mapping.load).toBe(4)
    expect(mapping.notes).toBeNull()
  })
})

describe('import — the cues come in, and the cue column with them', () => {
  it('a stacked sheet with a Comments column: cues stored, cue column on', async () => {
    const { program, exercises, preview } = await commit(await buildSheet(COMMENTED), 'Commented')
    expect(preview.columnMapping.notes).toBe(6)
    expect(exercises).toEqual([
      { name: 'Squat', notes: 'pause 2 s at the bottom' },
      { name: 'Bench Press', notes: null },
      { name: 'Barbell Row', notes: 'strict, no hip drive' },
    ])
    expect(JSON.parse(program.enabled_columns!)).toEqual([...DEFAULT_ENABLED_COLUMNS, 'notes'])
  })

  it('a sheet without one comes in exactly as before: no cues, column choice untouched', async () => {
    const plain = COMMENTED.map((row) => row.slice(0, 5))
    const { program, exercises } = await commit(await buildSheet(plain), 'Plain')
    expect(exercises.every((e) => e.notes === null)).toBe(true)
    expect(program.enabled_columns).toBeNull()
  })

  it('a Comments column with nothing in it does not switch the cue column on', async () => {
    const empty = COMMENTED.map((row, i) => (i < 1 ? row : row.slice(0, 5)))
    const { program } = await commit(await buildSheet(empty), 'Empty comments')
    expect(program.enabled_columns).toBeNull()
  })

  it("an athlete's comments column is not read as cues", async () => {
    const athlete = COMMENTED.map((row, i) => (i === 0 ? [...row.slice(0, 5), 'Athlete comments'] : row))
    const { program, exercises } = await commit(await buildSheet(athlete), 'Athlete comments')
    expect(exercises.every((e) => e.notes === null)).toBe(true)
    expect(program.enabled_columns).toBeNull()
  })

  it('the coach can point the Notes field at a column by hand', async () => {
    const odd = COMMENTED.map((row, i) => (i === 0 ? [...row.slice(0, 5), 'Extra'] : row))
    const auto = await parseExternalFile(await buildSheet(odd))
    expect(auto.columnMapping.notes).toBeNull()
    const pinned = await parseExternalFile(await buildSheet(odd), { notes: 6 })
    expect(pinned.columnMapping.notes).toBe(6)
    expect(pinned.exercises[0].notes).toBe('pause 2 s at the bottom')
  })

  it("CoachBoard's own export with the cue column on reads back with its cues", async () => {
    const p = await createProgram({
      athlete_id: athleteId, name: 'Own export', enabled_columns: [...DEFAULT_ENABLED_COLUMNS, 'notes'],
    })
    await setProgramDuration(p.id, '2026-06-08', 2)
    for (const date of ['2026-06-08', '2026-06-15']) {
      const w = await createWorkout({ program_id: p.id, name: 'Monday', scheduled_date: date })
      await createExercise({ workout_id: w.id, name: 'Squat', sets: '3', reps: '5', notes: 'pause 2 s', order_index: 0 })
      await createExercise({ workout_id: w.id, name: 'Bench Press', sets: '3', reps: '8', order_index: 1 })
    }
    const preview = await parseExternalFile((await buildProgramWorkbook(p.id)).buffer)
    expect(preview.errors).toEqual([])
    expect(preview.layout).toBe('horizontal')
    expect(preview.exercises.map((e) => [e.weekIndex, e.name, e.notes])).toEqual([
      [0, 'Squat', 'pause 2 s'], [1, 'Squat', 'pause 2 s'],
      [0, 'Bench Press', null], [1, 'Bench Press', null],
    ])
  })

  it('a block-grid sheet with a Notes column in each week block', async () => {
    const block = ['Movement', 'SETS', 'REPS', 'LOAD', 'RPE', 'Notes']
    const at = (w: number, vals: Cell[]) => { const row: Cell[] = []; vals.forEach((v, i) => { row[1 + w * 7 + i] = v }); return row }
    const merge = (...rows: Cell[][]) => rows.reduce((a, r) => { r.forEach((v, i) => { if (v !== undefined) a[i] = v }); return a }, [] as Cell[])
    const sheet: Cell[][] = [
      merge(at(0, ['DAY 1', 'Week 1']), at(1, ['DAY 1', 'Week 2'])),
      merge(at(0, block), at(1, block)),
      merge(at(0, ['Squat', 3, 5, 100, '@7', 'brace hard']), at(1, ['Squat', 3, 5, 105, '@8', 'brace harder'])),
      merge(at(0, ['Bench', 3, 8, 80, '@7', null]), at(1, ['Bench', 3, 8, 82.5, '@7', null])),
    ]
    const preview = await parseExternalFile(await buildSheet(sheet))
    expect(preview.errors).toEqual([])
    expect(preview.layout).toBe('block-grid')
    expect(preview.exercises.map((e) => [e.weekIndex, e.name, e.notes])).toEqual([
      [0, 'Squat', 'brace hard'], [1, 'Squat', 'brace harder'],
      [0, 'Bench', null], [1, 'Bench', null],
    ])
    expect(preview.layoutTemplate?.columns.at(-1)).toEqual({ key: 'notes', label: 'Notes' })
  })
})

describe("the coach's style keeps the notes column", () => {
  it('captures it with the coach’s own wording, last', async () => {
    const preview = await parseExternalFile(await buildSheet(COMMENTED))
    expect(preview.layoutTemplate?.columns.map((c) => c.key)).toEqual(['name', 'sets', 'reps', 'load_cap', 'intensity', 'notes'])
    expect(preview.layoutTemplate?.columns.at(-1)?.label).toBe('Comments')
  })
})

describe('export — the cues go back into their own column', () => {
  it("the coach's own sheet re-filled: cues in Comments, names left as names", async () => {
    const { programId } = await commit(await buildSheet(COMMENTED), 'Refill on')
    const ws = await sheetOf((await buildProgramWorkbook(programId)).buffer)
    const rowOf = (name: string) => {
      for (let r = 1; r <= ws.rowCount; r++) if (text(ws, r, 1) === name) return r
      throw new Error(`${name} not in the sheet`)
    }
    expect(text(ws, 1, 6)).toBe('Comments')
    expect(text(ws, rowOf('Squat'), 6)).toBe('pause 2 s at the bottom')
    expect(text(ws, rowOf('Bench Press'), 6)).toBe('')
    expect(text(ws, rowOf('Barbell Row'), 6)).toBe('strict, no hip drive')
    expect(allText(ws).some((t) => t.startsWith('Squat - '))).toBe(false)
  })

  it('with the cue column switched off, the Comments column goes out empty', async () => {
    const { programId } = await commit(await buildSheet(COMMENTED), 'Refill off')
    await setCues(programId, false)
    const cells = allText(await sheetOf((await buildProgramWorkbook(programId)).buffer))
    expect(cells).toContain('Comments')
    expect(cells.some((t) => t.includes('pause 2 s') || t.includes('hip drive'))).toBe(false)
  })

  describe('the captured style alone (no stored workbook)', () => {
    async function styled(on: boolean) {
      const preview = await parseExternalFile(await buildSheet(COMMENTED))
      const { programId } = await commitExternalProgram(preview.exercises, {
        athleteId, name: `Style ${on}`, status: 'active', startDate: '2026-06-08', weeks: preview.weeks,
        exportLayout: preview.layoutTemplate ?? null,
      })
      await setCues(programId, on)
      return programId
    }

    // Results read back through a style with its own notes column: cueRoundTrip.test.ts.
    it('on: the cue in the Comments column, on its own row, nothing after the name', async () => {
      const programId = await styled(true)
      const ws = await sheetOf((await buildProgramWorkbook(programId)).buffer)
      expect(allText(ws).some((t) => t.startsWith('Squat - '))).toBe(false)

      let headerRow = 0, nameCol = 0, notesCol = 0
      for (let r = 1; r <= ws.rowCount && !headerRow; r++) {
        for (let c = 1; c <= ws.columnCount; c++) {
          if (text(ws, r, c) === 'Exercise') { headerRow = r; nameCol = c }
          if (headerRow === r && text(ws, r, c) === 'Comments') notesCol = c
        }
      }
      expect(notesCol).toBeGreaterThan(nameCol)
      let squatRow = 0
      for (let r = headerRow + 1; r <= ws.rowCount && !squatRow; r++) if (text(ws, r, nameCol) === 'Squat') squatRow = r
      expect(text(ws, squatRow, notesCol)).toBe('pause 2 s at the bottom')
      expect(text(ws, squatRow + 1, notesCol)).toBe('')
    })

    it('off: the Notes column is there but empty', async () => {
      const programId = await styled(false)
      const cells = allText(await sheetOf((await buildProgramWorkbook(programId)).buffer))
      expect(cells).toContain('Comments')
      expect(cells.some((t) => t.includes('pause 2 s') || t.includes('hip drive'))).toBe(false)
    })
  })
})
