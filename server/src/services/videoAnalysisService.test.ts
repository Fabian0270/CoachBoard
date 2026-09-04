import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initializeDatabase, getDb } from '../db.js'
import { configureSecureStore } from './secureStore.js'
import { saveAnalysis, listAnalyses, getAnalysis } from './videoAnalysisService.js'
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
