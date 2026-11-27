import { describe, it, expect } from 'vitest'
import { repDrift } from 'coachboard-shared/videoAnalysis'
import { fmtDrift } from './RepTable'

// Sideways travel per rep (BP8), from the tracked path.

// A concentric from t=1 (bottom, x=100) to t=2 (top). It swings 30 px right,
// then finishes 10 px right of where it started. 1 px = 1 mm (1000 px per metre).
const track = [
  { t: 0.5, x: 90, y: 400 },   // before the rep: not counted
  { t: 1.0, x: 100, y: 400 },
  { t: 1.3, x: 130, y: 300 },
  { t: 1.6, x: 120, y: 200 },
  { t: 2.0, x: 110, y: 100 },
  { t: 2.5, x: 60, y: 100 },   // after the top: not counted
]

describe('repDrift', () => {
  it('the furthest from the line through the bottom, and where the top ended up', () => {
    expect(repDrift(track, { startT: 1, endT: 2 }, 1000)).toEqual({ maxPx: 30, netPx: 10, maxM: 0.03, netM: 0.01 })
  })
  it('in pixels without a scale', () => {
    expect(repDrift(track, { startT: 1, endT: 2 }, null)).toEqual({ maxPx: 30, netPx: 10, maxM: null, netM: null })
  })
  it('nothing for a rep with no path in it', () => {
    expect(repDrift(track, { startT: 3, endT: 4 }, 1000)).toBeNull()
  })
})

describe('fmtDrift', () => {
  it('says it in cm, with the direction the top ended up in', () => {
    expect(fmtDrift({ maxPx: 30, netPx: 10, maxM: 0.03, netM: 0.01 })).toBe('3 cm, ends 1 cm →')
    expect(fmtDrift({ maxPx: 30, netPx: -20, maxM: 0.03, netM: -0.02 })).toBe('3 cm, ends 2 cm ←')
    expect(fmtDrift({ maxPx: 4, netPx: 0, maxM: 0.004, netM: 0 })).toBe('0 cm, ends centred')
    expect(fmtDrift({ maxPx: 30, netPx: 10, maxM: null, netM: null })).toBe('30 px, ends 10 px →')
  })
})
