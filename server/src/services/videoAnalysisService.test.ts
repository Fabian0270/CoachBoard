import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initializeDatabase, getDb } from '../db.js'
import { configureSecureStore } from './secureStore.js'
import { saveAnalysis, listAnalyses, getAnalysis, setAnalysisAthlete } from './videoAnalysisService.js'
import type { SaveVideoAnalysisInput } from 'coachboard-shared/videoAnalysis'

let tmpDir: string

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-analysis-'))
  configureSecureStore({ safeStorage: null, userDataDir: tmpDir })
  await initializeDatabase(path.join(tmpDir, 'test.sqlite'))
})

afterEach(async () => {
  await getDb().destroy()
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

function input(overrides: Partial<SaveVideoAnalysisInput> = {}): SaveVideoAnalysisInput {
  return {
    mediaId: null,
    athleteId: null,
    sourceLabel: 'squat.mp4',
    track: [
      { t: 0, x: 10, y: 100 },
      { t: 0.5, x: 10, y: 60 },
      { t: 1, x: 10, y: 100 },
    ],
    calibration: null,
    metrics: [],
    notes: null,
    metric: null,
    lift: null,
    loadKg: null,
    calledRpe: null,
    ...overrides,
  }
}

async function createAthlete(id: string): Promise<string> {
  await getDb()
    .insertInto('athletes')
    .values({
      id,
      name: 'Test Lifter',
      email: null,
      sport: null,
      weight_class: null,
      date_of_birth: null,
      notes: null,
      archived: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .execute()
  return id
}

describe('videoAnalysisService set context', () => {
  it('round-trips the lift, load and called RPE', async () => {
    const saved = await saveAnalysis(
      input({ lift: 'back-squat', loadKg: 172.5, calledRpe: 8.5 }),
    )
    expect(saved.lift).toBe('back-squat')
    expect(saved.loadKg).toBe(172.5)
    expect(saved.calledRpe).toBe(8.5)

    const read = await getAnalysis(saved.id)
    expect(read?.lift).toBe('back-squat')
    expect(read?.loadKg).toBe(172.5)
    expect(read?.calledRpe).toBe(8.5)
  })

  it('leaves them null when the coach did not fill them in', async () => {
    // Looking at a bar path must never require filling in a form first.
    const saved = await saveAnalysis(input())
    expect(saved.lift).toBeNull()
    expect(saved.loadKg).toBeNull()
    expect(saved.calledRpe).toBeNull()
  })
})

describe('listAnalyses withTrack', () => {
  it('omits the path but keeps everything the velocity panel reads', async () => {
    const athleteId = await createAthlete('a-1')
    await saveAnalysis(input({ athleteId, lift: 'bench-press', loadKg: 100, calledRpe: 9 }))

    const [row] = await listAnalyses({ athleteId, withTrack: false })
    expect(row.track).toEqual([])
    expect(row.lift).toBe('bench-press')
    expect(row.loadKg).toBe(100)
    expect(row.calledRpe).toBe(9)
    expect(row.athleteName).toBe('Test Lifter')
  })

  it('still returns the path by default', async () => {
    const athleteId = await createAthlete('a-2')
    await saveAnalysis(input({ athleteId }))

    const [row] = await listAnalyses({ athleteId })
    expect(row.track).toHaveLength(3)
  })
})

describe('setAnalysisAthlete', () => {
  it('attaches an orphan to an athlete after the fact', async () => {
    // A local file saves with no athlete, so it feeds nobody's profile until
    // someone says whose it is. Before this there was no way to say so.
    const athleteId = await createAthlete('a-3')
    const saved = await saveAnalysis(input({ lift: 'back-squat', loadKg: 180 }))
    expect(saved.athleteId).toBeNull()

    const attached = await setAnalysisAthlete(saved.id, athleteId)
    expect(attached?.athleteId).toBe(athleteId)
    expect(attached?.athleteName).toBe('Test Lifter')

    // And it now shows up in that athlete's history, which is the point.
    const rows = await listAnalyses({ athleteId, withTrack: false })
    expect(rows.map((r) => r.id)).toContain(saved.id)
  })

  it('detaches when given null', async () => {
    const athleteId = await createAthlete('a-4')
    const saved = await saveAnalysis(input({ athleteId }))
    expect((await setAnalysisAthlete(saved.id, null))?.athleteId).toBeNull()
  })

  it('leaves the measurement alone', async () => {
    // Only the athlete is mutable — a path and its metrics are what was tracked.
    const athleteId = await createAthlete('a-5')
    const saved = await saveAnalysis(input({ lift: 'bench-press', loadKg: 170, calledRpe: 8 }))
    const attached = await setAnalysisAthlete(saved.id, athleteId)
    expect(attached?.lift).toBe('bench-press')
    expect(attached?.loadKg).toBe(170)
    expect(attached?.calledRpe).toBe(8)
    expect(attached?.track).toHaveLength(3)
  })

  it('reports a miss rather than pretending', async () => {
    expect(await setAnalysisAthlete('does-not-exist', null)).toBeNull()
  })
})

describe('updateAnalysisContext', () => {
  it('corrects what the set was and leaves the measurement alone', async () => {
    // A load typed after pressing Save used to go nowhere, and it is the load
    // that builds the athlete's velocity profile.
    const { updateAnalysisContext } = await import('./videoAnalysisService.js')
    const saved = await saveAnalysis(input({ lift: 'back-squat', loadKg: null, calledRpe: null }))
    const updated = await updateAnalysisContext(saved.id, { loadKg: 180, calledRpe: 8.5 })
    expect(updated).toMatchObject({ lift: 'back-squat', loadKg: 180, calledRpe: 8.5 })
    expect(updated?.track).toEqual(saved.track)

    const cleared = await updateAnalysisContext(saved.id, { lift: null })
    expect(cleared?.lift).toBeNull()
    expect(cleared?.loadKg).toBe(180)
  })

  it("replaces the set's reps when one is struck off, and puts them back for Undo (BP4)", async () => {
    const { updateAnalysisContext } = await import('./videoAnalysisService.js')
    const rep = (index: number) => ({ index, meanVelocity: 0.5 - index * 0.05 })
    const saved = await saveAnalysis(input({ metrics: [rep(0), rep(1), rep(2)] as never }))
    const struck = await updateAnalysisContext(saved.id, { metrics: [rep(0), rep(2)] })
    expect(struck?.metrics.map((m) => m.index)).toEqual([0, 2])
    expect((await getAnalysis(saved.id))?.metrics.map((m) => m.index)).toEqual([0, 2])
    const back = await updateAnalysisContext(saved.id, { metrics: [rep(0), rep(1), rep(2)] })
    expect(back?.metrics.map((m) => m.index)).toEqual([0, 1, 2])
    expect(back?.track).toEqual(saved.track)
  })

  it("keeps the coach's note on the set, and clears it when blanked (BP23)", async () => {
    const { updateAnalysisContext } = await import('./videoAnalysisService.js')
    const saved = await saveAnalysis(input())
    expect((await updateAnalysisContext(saved.id, { notes: '  Drive the hips through  ' }))?.notes).toBe('Drive the hips through')
    expect((await getAnalysis(saved.id))?.notes).toBe('Drive the hips through')
    expect((await updateAnalysisContext(saved.id, { notes: '   ' }))?.notes).toBeNull()
  })

  it('reports a miss', async () => {
    const { updateAnalysisContext } = await import('./videoAnalysisService.js')
    expect(await updateAnalysisContext('does-not-exist', { loadKg: 100 })).toBeNull()
  })
})
