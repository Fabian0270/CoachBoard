import { beforeAll, describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { initializeDatabase, getDb } from '../db.js'
import { createAthlete } from './athleteService.js'
import { createProgram, setProgramDuration, createWorkout, createExercise } from './programService.js'
import { buildProgramWorkbook } from './programExport.js'
import { parseExternalFile } from './externalImportService.js'
import { storeTemplate } from './templateBlobStore.js'

// An export must contain the whole program, whatever style it is rendered in.
//
// The audit measured the styled export against the six fixture templates with
// a program one exercise longer per day than the template, plus a Sunday the
// template has no section for: the Sunday vanished from 5 of 6, and one sheet
// carried only 3 of 7 exercises. Nothing said so. These cases read the REAL
// exported file back and look for every exercise by name.

const FIXTURES = path.join(__dirname, '__fixtures__', 'external-import')
let athleteId = ''

beforeAll(async () => {
  await initializeDatabase(':memory:')
  athleteId = (await createAthlete({ name: 'Lifter' })).id
})

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** A one-week program in the fixture's style that outgrows it. Returns the exercise names. */
async function programOutgrowing(fixture: string): Promise<{ programId: string; names: string[] }> {
  const buffer = fs.readFileSync(path.join(FIXTURES, fixture))
  const template = await parseExternalFile(buffer)
  const week0 = template.exercises.filter((e) => e.weekIndex === 0)
  const days = [...new Set(week0.map((e) => e.dayIndex))].sort((a, b) => a - b)

  const start = '2026-01-05' // a Monday
  const program = await createProgram({ athlete_id: athleteId, name: fixture })
  await setProgramDuration(program.id, start, 1)
  await getDb()
    .updateTable('programs')
    .set({ export_template_sha: await storeTemplate(buffer.toString('base64')) })
    .where('id', '=', program.id)
    .execute()

  const names: string[] = []
  const addDay = async (offset: number, count: number, tag: string) => {
    const date = addDays(start, offset)
    const w = await createWorkout({ program_id: program.id, name: date, scheduled_date: date })
    for (let i = 0; i < count; i++) {
      const name = `ZZ ${tag} ex${i + 1}`
      names.push(name)
      await createExercise({ workout_id: w.id, name, sets: '3', reps: '5', weight: 100, order_index: i })
    }
  }
  for (const [k, d] of days.entries()) {
    await addDay(Math.min(d, 5), week0.filter((e) => e.dayIndex === d).length + 1, `day${k + 1}`)
  }
  await addDay(6, 2, 'sunday')
  return { programId: program.id, names }
}

describe('a program that outgrows its imported style', () => {
  for (const fixture of fs.readdirSync(FIXTURES).filter((f) => f.endsWith('.xlsx'))) {
    it(`${fixture}: the exported file carries every exercise`, async () => {
      const { programId, names } = await programOutgrowing(fixture)
      const built = await buildProgramWorkbook(programId)

      const exported = await parseExternalFile(built.buffer)
      const found = new Set(exported.exercises.map((e) => e.name))
      expect(names.filter((n) => !found.has(n))).toEqual([])

      // And the switch to the built-in look is explained, not silent — either
      // because the program outgrew the style, or (one fixture) because its
      // layout is one the styled export cannot reproduce at all.
      expect(built.notice).toMatch(/no room for .* on .*Sunday|can't be reproduced/)
    })
  }
})

describe('the Minimalistic look', () => {
  it('carries the prescription, not only the result columns', async () => {
    // It used to have Exercise/Sets/Reps/Load/RPE only — so a generated program
    // reached the athlete with no prescribed weight and no target effort.
    const program = await createProgram({ athlete_id: athleteId, name: 'Minimal', builtin_template: 'minimal' })
    await setProgramDuration(program.id, '2026-01-05', 1)
    const w = await createWorkout({ program_id: program.id, name: 'Mon', scheduled_date: '2026-01-05' })
    await createExercise({ workout_id: w.id, name: 'Squat', sets: '4', reps: '5', weight: 162.5, intensity: 'RPE 8' })

    const { buffer, notice } = await buildProgramWorkbook(program.id)
    const { renderWorkbookHtml } = await import('./programPreview.js')
    const text = (await renderWorkbookHtml(buffer)).replace(/<[^>]+>/g, ' ')
    expect(text).toContain('162.5')
    expect(text).toContain('RPE 8')
    expect(notice).toBeNull()
  })
})
