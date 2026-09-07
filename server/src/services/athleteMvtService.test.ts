import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initializeDatabase, getDb } from '../db.js'
import { createAthlete } from './athleteService.js'
import { getAthleteMvts, setAthleteMvt } from './athleteMvtService.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-mvt-'))

afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

let athleteId: string
let otherId: string

beforeEach(async () => {
  await initializeDatabase(':memory:')
  athleteId = (await createAthlete({ name: 'Fabian' })).id
  otherId = (await createAthlete({ name: 'Someone else' })).id
})

describe('remembering a measured 1RM velocity', () => {
  it('keeps a separate value per lift', async () => {
    await setAthleteMvt(athleteId, 'back-squat', 0.1)
    await setAthleteMvt(athleteId, 'bench-press', 0.17)

    expect(await getAthleteMvts(athleteId)).toEqual({
      'back-squat': 0.1,
      'bench-press': 0.17,
    })
  })

  it('keeps a separate value per athlete', async () => {
    // The number is a property of the pair — one lifter's squat says nothing
    // about another's.
    await setAthleteMvt(athleteId, 'back-squat', 0.1)
    await setAthleteMvt(otherId, 'back-squat', 0.28)

    expect((await getAthleteMvts(athleteId))['back-squat']).toBe(0.1)
    expect((await getAthleteMvts(otherId))['back-squat']).toBe(0.28)
  })

  it('replaces rather than accumulating when it is measured again', async () => {
    await setAthleteMvt(athleteId, 'back-squat', 0.1)
    await setAthleteMvt(athleteId, 'back-squat', 0.12)

    expect((await getAthleteMvts(athleteId))['back-squat']).toBe(0.12)
    const rows = await getDb().selectFrom('athlete_mvt').selectAll().execute()
    expect(rows).toHaveLength(1)
  })

  it('clears on null, so the published band takes over again', async () => {
    // "Not measured" and "measured as nothing" are different states, and only
    // the first should fall back to the population figure.
    await setAthleteMvt(athleteId, 'back-squat', 0.1)
    await setAthleteMvt(athleteId, 'back-squat', null)
    expect(await getAthleteMvts(athleteId)).toEqual({})
  })

  it('returns an empty map for an athlete who has never had one', async () => {
    expect(await getAthleteMvts(athleteId)).toEqual({})
  })

  it('refuses a value that is not a plausible bar speed', async () => {
    // A typo here silently rescales every RPE reading and 1RM estimate.
    for (const bad of [0, -0.1, 12, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(setAthleteMvt(athleteId, 'back-squat', bad)).rejects.toThrow()
    }
    expect(await getAthleteMvts(athleteId)).toEqual({})
  })

  it('goes with the athlete when they are deleted', async () => {
    // Unlike a saved analysis, this is a property OF the athlete rather than
    // the coach's separate work, so it has no meaning once they are gone.
    await setAthleteMvt(athleteId, 'back-squat', 0.1)
    await getDb().deleteFrom('athletes').where('id', '=', athleteId).execute()
    expect(await getDb().selectFrom('athlete_mvt').selectAll().execute()).toHaveLength(0)
  })
})
