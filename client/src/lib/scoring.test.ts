import { describe, it, expect } from 'vitest'
import { dots, wilks, ipfGlPoints, allScores } from 'coachboard-shared/scoring'

describe('ipfGlPoints', () => {
  it('matches the official IPF GL formula for known inputs', () => {
    // 83 kg male, 700 kg classic full-meet total.
    expect(ipfGlPoints(700, 83, 'male', 'classic', 'full')).toBeCloseTo(96.9, 1)
    // 63 kg female, 400 kg classic full-meet total.
    expect(ipfGlPoints(400, 63, 'female', 'classic', 'full')).toBeCloseTo(87.51, 1)
    // 93 kg male, 250 kg classic bench-only.
    expect(ipfGlPoints(250, 93, 'male', 'classic', 'bench')).toBeCloseTo(118.61, 1)
  })

  it('uses distinct coefficients per equipment/event', () => {
    const base = { t: 700, bw: 83 } as const
    const classicFull = ipfGlPoints(base.t, base.bw, 'male', 'classic', 'full')
    const equippedFull = ipfGlPoints(base.t, base.bw, 'male', 'equipped', 'full')
    const classicBench = ipfGlPoints(base.t, base.bw, 'male', 'classic', 'bench')
    expect(classicFull).not.toBeCloseTo(equippedFull!, 1)
    expect(classicFull).not.toBeCloseTo(classicBench!, 1)
  })

  it('rejects invalid input', () => {
    expect(ipfGlPoints(0, 83, 'male', 'classic', 'full')).toBeNull()
    expect(ipfGlPoints(700, 10, 'male', 'classic', 'full')).toBeNull()
  })
})

describe('dots', () => {
  it('matches known values', () => {
    expect(dots(700, 83, 'male')).toBeCloseTo(472.56, 1)
    expect(dots(400, 63, 'female')).toBeCloseTo(430.21, 1)
  })

  it('rejects invalid input', () => {
    expect(dots(-5, 83, 'male')).toBeNull()
    expect(dots(700, 0, 'male')).toBeNull()
  })
})

describe('wilks', () => {
  it('matches known values', () => {
    expect(wilks(700, 83, 'male')).toBeCloseTo(467.25, 1)
    expect(wilks(400, 63, 'female')).toBeCloseTo(429.58, 1)
  })
})

describe('cross-check', () => {
  it('DOTS and Wilks track each other closely (independent coefficient sets)', () => {
    const s = allScores({ total: 700, bodyweight: 83, sex: 'male', equipment: 'classic', event: 'full' })
    expect(Math.abs(s.dots! - s.wilks!)).toBeLessThan(15)
  })

  it('a heavier lifter at the same total scores lower (diminishing returns)', () => {
    const light = dots(600, 70, 'male')!
    const heavy = dots(600, 120, 'male')!
    expect(light).toBeGreaterThan(heavy)
  })
})
