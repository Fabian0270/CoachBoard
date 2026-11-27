import { describe, expect, it } from 'vitest'
import { lastTimeAtLoad, velocityPr, velocityPrTimeline, type HistorySet } from './setHistory'

// Compare with last time (BP29, D53) and velocity PRs (BP35, D54).

const rep = (mean: number, peak = mean * 1.3) => ({
  index: 0, startT: 1, endT: 2, durationMs: 900, romPx: 200, meanVelocityPxS: mean * 300, peakVelocityPxS: peak * 300,
  romM: 0.7, meanVelocity: mean, peakVelocity: peak, meanPropulsiveVelocity: null, propulsiveFraction: null,
})
const set = (id: string, day: string, loadKg: number | null, means: number[], lift = 'back-squat'): HistorySet => ({
  id, lift, loadKg, createdAt: `2026-11-${day}T10:00:00Z`, metrics: means.map((m) => rep(m)),
})

const rows = [
  set('a', '01', 180, [0.40, 0.45]),
  set('b', '05', 180, [0.50]),
  set('c', '07', 182.5, [0.70]),
  set('d', '08', 180, [0.60], 'bench-press'),
]

describe('lastTimeAtLoad', () => {
  it('the most recent earlier set of the same lift at exactly the same kilos', () => {
    expect(lastTimeAtLoad(rows, set('x', '10', 180, [0.5]))?.id).toBe('b')
  })
  it('none at a load never lifted before, and not a later set', () => {
    expect(lastTimeAtLoad(rows, set('x', '10', 185, [0.5]))).toBeNull()
    expect(lastTimeAtLoad(rows, set('x', '03', 180, [0.5]))?.id).toBe('a')
  })
})

describe('velocityPr', () => {
  it('a PR when the fastest rep beats every earlier set at that load', () => {
    expect(velocityPr(rows, set('x', '10', 180, [0.48, 0.55]), 'mean')).toEqual({ kind: 'pr', best: 0.55, previous: 0.5 })
  })
  it('not a PR when slower, and other loads and lifts do not count', () => {
    expect(velocityPr(rows, set('x', '10', 180, [0.49]), 'mean')).toBeNull()
  })
  it('the first set at a load', () => {
    expect(velocityPr(rows, set('x', '10', 190, [0.3]), 'mean')).toEqual({ kind: 'first', best: 0.3 })
  })
  it('a mistracked rep is no PR', () => {
    const glitch = { ...set('x', '10', 180, [0.4]), metrics: [rep(0.4), rep(0.2, 1.9)] }
    expect(velocityPr(rows, glitch, 'peak')).toBeNull()
  })
  it('the timeline lists each PR, newest first, and not first sets at a load', () => {
    const all = [...rows, set('e', '12', 180, [0.52]), set('f', '14', 180, [0.51]), set('g', '15', 182.5, [0.8])]
    expect(velocityPrTimeline(all).map((e) => [e.id, e.best, e.previous])).toEqual([
      ['g', 0.8, 0.7],
      ['e', 0.52, 0.5],
      ['b', 0.5, 0.45],
    ])
  })

  it('nothing without a scale', () => {
    const raw = { ...set('x', '10', 180, [0.6]), metrics: [{ ...rep(0.6), meanVelocity: null, peakVelocity: null, romM: null }] }
    expect(velocityPr(rows, raw, 'mean')).toBeNull()
  })
})
