import { describe, it, expect, beforeEach } from 'vitest'
import { initializeDatabase, getDb } from '../db.js'
import { createAthlete } from './athleteService.js'
import { saveAnalysis } from './videoAnalysisService.js'
import { getReferenceReps, ReferenceRepRefused, setReferenceRep } from './referenceRepService.js'

// An athlete's reference rep per lift (BP28).

let athleteId: string
let otherId: string

const rep = (index: number) => ({
  index, startT: index, endT: index + 0.8, durationMs: 800, romPx: 300, meanVelocityPxS: 300, peakVelocityPxS: 400,
  romM: 0.5, meanVelocity: 0.5, peakVelocity: 0.7, meanPropulsiveVelocity: null, propulsiveFraction: null,
})
const save = (athlete: string | null, lift: string) => saveAnalysis({
  mediaId: null, athleteId: athlete, sourceLabel: 'clip.mp4',
  track: [{ t: 0, x: 0, y: 0 }, { t: 1, x: 0, y: 10 }],
  calibration: null, metrics: [rep(0), rep(1)], notes: null, lift, loadKg: 180, calledRpe: null, metric: null,
})

beforeEach(async () => {
  await initializeDatabase(':memory:')
  athleteId = (await createAthlete({ name: 'Anna' })).id
  otherId = (await createAthlete({ name: 'Bo' })).id
})

describe('reference reps', () => {
  it('one per athlete and lift; marking another replaces it, null clears it', async () => {
    const a = await save(athleteId, 'back-squat')
    const b = await save(athleteId, 'back-squat')
    await setReferenceRep(athleteId, 'back-squat', a.id, 1)
    await setReferenceRep(athleteId, 'back-squat', b.id, 0)
    expect(await getReferenceReps(athleteId)).toEqual({ 'back-squat': { analysisId: b.id, repIndex: 0 } })
    await setReferenceRep(athleteId, 'back-squat', null)
    expect(await getReferenceReps(athleteId)).toEqual({})
  })

  it("refuses another athlete's set, another lift, or a rep the set does not have", async () => {
    const theirs = await save(otherId, 'back-squat')
    const bench = await save(athleteId, 'bench-press')
    const mine = await save(athleteId, 'back-squat')
    await expect(setReferenceRep(athleteId, 'back-squat', theirs.id, 0)).rejects.toThrow(ReferenceRepRefused)
    await expect(setReferenceRep(athleteId, 'back-squat', bench.id, 0)).rejects.toThrow(ReferenceRepRefused)
    await expect(setReferenceRep(athleteId, 'back-squat', mine.id, 5)).rejects.toThrow(ReferenceRepRefused)
  })

  it('goes with the set it points at', async () => {
    const a = await save(athleteId, 'back-squat')
    await setReferenceRep(athleteId, 'back-squat', a.id, 0)
    await getDb().deleteFrom('video_analyses').where('id', '=', a.id).execute()
    expect(await getReferenceReps(athleteId)).toEqual({})
  })
})
