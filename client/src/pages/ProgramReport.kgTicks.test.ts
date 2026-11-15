import { describe, it, expect } from 'vitest'
import { kgTicks } from './ProgramReport'

describe('kgTicks', () => {
  it('gives evenly spaced whole-kilo ticks that bracket the data', () => {
    expect(kgTicks([230, 230, 236.2, 233.2])).toEqual([230, 232, 234, 236, 238])
    expect(kgTicks([169.05, 169.05, 169.7, 165.6])).toEqual([164, 166, 168, 170])
  })

  it('never produces decimal ticks for a tiny range', () => {
    expect(kgTicks([100.1, 100.4])).toEqual([100, 101])
  })

  it('scales the step up for a wide range', () => {
    expect(kgTicks([100, 300])).toEqual([100, 150, 200, 250, 300])
  })

  it('gives a flat line room above and below', () => {
    expect(kgTicks([200, 200])).toEqual([199, 200, 201])
  })
})
