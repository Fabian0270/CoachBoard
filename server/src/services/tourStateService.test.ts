import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initializeDatabase, getDb } from '../db.js'
import { configureSecureStore } from './secureStore.js'
import { createAthlete } from './athleteService.js'
import { loadSampleAthlete } from './sampleService.js'
import { configureRatesFetcher } from './ratesService.js'
import { tourStatus, updateTourState } from './tourStateService.js'

// T8: the tour and checklist state lives with the app's data.

vi.spyOn(console, 'log').mockImplementation(() => {})

let dir = ''
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coachboard-tour-'))
  configureSecureStore({ safeStorage: null, userDataDir: dir })
  configureRatesFetcher(async () => { throw new Error('offline') })
  await initializeDatabase(path.join(dir, 'coachboard.sqlite'))
})
afterEach(async () => {
  await getDb().destroy()
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows lock */ }
})

describe('tour state', () => {
  it('starts empty; the sample athlete does not count as the coach’s own data', async () => {
    expect(await tourStatus()).toEqual({
      welcomeAnswered: false, tourAt: null, tourFinished: false,
      checklist: { completed: [], skipped: [], done: false }, hasOwnData: false,
    })
    await loadSampleAthlete('2026-11-19')
    expect((await tourStatus()).hasOwnData).toBe(false)
    await createAthlete({ name: 'Real', unit: 'kg' })
    expect((await tourStatus()).hasOwnData).toBe(true)
  })

  it('keeps what changed and leaves the rest', async () => {
    await updateTourState({ welcomeAnswered: true, tourAt: 4 })
    await updateTourState({ checklist: { completed: ['athlete'] } })
    const s = await updateTourState({ checklist: { skipped: ['discord'] } })
    expect(s).toMatchObject({ welcomeAnswered: true, tourAt: 4, checklist: { completed: ['athlete'], skipped: ['discord'], done: false } })
    expect((await updateTourState({ tourAt: null, tourFinished: true }))).toMatchObject({ tourAt: null, tourFinished: true })
  })
})
