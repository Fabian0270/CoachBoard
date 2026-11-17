import { describe, expect, it } from 'vitest'
import { readSessions, type SessionSet } from 'coachboard-shared/vbtSession'

// Today's estimated max from one day's sets (BP33, D59).

const MVT = 0.3
// A day on the line v = 1.3 − load/max: the 1RM (at 0.3 m/s) is `max` kg.
const day = (date: string, max: number, loads: number[]): SessionSet[] =>
  loads.map((load, i) => ({
    id: `${date}-${i}`,
    lift: 'back-squat',
    loadKg: load,
    liftedAt: `${date}T12:00:00`,
    metrics: [{
      index: 0, startT: 0, endT: 1, durationMs: 900, romPx: 200, meanVelocityPxS: 1, peakVelocityPxS: 1.2,
      romM: 0.7, meanVelocity: 1.3 - load / max, peakVelocity: (1.3 - load / max) * 1.2, meanPropulsiveVelocity: null, propulsiveFraction: null,
    }],
  }))

describe('readSessions', () => {
  it("today's max off the day's line, against the median of the other days", () => {
    const sets = [
      ...day('2026-11-01', 200, [100, 140, 170]),
      ...day('2026-11-05', 210, [100, 140, 170]),
      ...day('2026-11-08', 205, [100, 140, 170]),
      ...day('2026-11-12', 190, [100, 140, 170]),
    ]
    const [latest] = readSessions(sets, 'back-squat', MVT)
    expect(latest.day).toBe('2026-11-12')
    expect(latest.todayMax).toBeCloseTo(190, 0)
    expect(latest.usualMax).toBeCloseTo(205, 0)
    expect(latest.vsUsual!).toBeCloseTo(190 / 205 - 1, 2)
  })

  it('a day with too few sets or bunched loads gets no number', () => {
    const sets = [...day('2026-11-01', 200, [100, 140]), ...day('2026-11-02', 200, [150, 152, 154])]
    const read = readSessions(sets, 'back-squat', MVT)
    expect(read.find((r) => r.day === '2026-11-01')).toMatchObject({ todayMax: null, unreadable: 'too-few-sets' })
    expect(read.find((r) => r.day === '2026-11-02')).toMatchObject({ todayMax: null, unreadable: 'unclear-line' })
  })

  it('no usual without another readable day', () => {
    const [only] = readSessions(day('2026-11-01', 200, [100, 140, 170]), 'back-squat', MVT)
    expect(only.todayMax).toBeCloseTo(200, 0)
    expect(only.usualMax).toBeNull()
    expect(only.vsUsual).toBeNull()
  })
})
