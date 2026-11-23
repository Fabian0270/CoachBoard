import { describe, it, expect } from 'vitest'
import { barPause, type BarMotionSample } from 'coachboard-shared/barPause'

// BP32, D122: the bench pause from the bar — completely still on the chest until it starts up.

const FPS = 30
const ROM = 250 // px; still = 0.5 px a frame

/**
 * A rep as the bar's frame-to-frame movement: down at `downSpeed` px a frame,
 * a settle of `settle` s at 0.35 px a frame (slow enough to look still), still
 * for `hold` s with ±`jitter` px of noise, then up. Returns the motion and when
 * the press began.
 */
function rep({ settle = 0.2, hold = 0.5, jitter = 0.1, downSpeed = 8, startAt = 1 } = {}) {
  const m: BarMotionSample[] = []
  let t = 0
  const push = (dy: number) => { m.push({ t, dy }); t += 1 / FPS }
  while (t < startAt) push(0.05 * (m.length % 2 ? 1 : -1)) // the top, held
  for (let i = 0; i < Math.round(ROM / downSpeed); i++) push(downSpeed)
  for (let i = 0; i < Math.round(settle * FPS); i++) push(0.35)
  for (let i = 0; i < Math.round(hold * FPS); i++) push(jitter * (i % 2 ? 1 : -1))
  const pressAt = t
  for (let i = 0; i < 20; i++) push(-12)
  return { motion: m, startT: pressAt }
}

describe('barPause', () => {
  it('a paused rep: from completely still (settle included) to the press', () => {
    const { motion, startT } = rep({ settle: 0.2, hold: 0.5 })
    const p = barPause(motion, { startT, romPx: ROM })!
    expect(Math.abs(p.pauseMs - 700)).toBeLessThan(80)
    expect(p.toT).toBeCloseTo(startT, 1)
  })

  it('a long pause reads long', () => {
    const { motion, startT } = rep({ settle: 0, hold: 1.1 })
    expect(Math.abs(barPause(motion, { startT, romPx: ROM })!.pauseMs - 1100)).toBeLessThan(80)
  })

  it('touch-and-go reads as no pause', () => {
    const { motion, startT } = rep({ settle: 0, hold: 0 })
    expect(barPause(motion, { startT, romPx: ROM })!.pauseMs).toBeLessThan(70)
  })

  it('jitter while still is still', () => {
    const { motion, startT } = rep({ settle: 0, hold: 0.6, jitter: 0.4 })
    expect(Math.abs(barPause(motion, { startT, romPx: ROM })!.pauseMs - 600)).toBeLessThan(80)
  })

  it('a sink in the middle splits it: only the stillness before the press counts', () => {
    const { motion, startT } = rep({ settle: 0, hold: 0.8 })
    // Halfway through, the bar sinks 2 px a frame for three frames — visibly moving.
    const k = motion.findIndex((m) => m.t >= startT - 0.4)
    for (let i = k; i < k + 3; i++) motion[i] = { ...motion[i], dy: 2 }
    const p = barPause(motion, { startT, romPx: ROM })!
    expect(p.pauseMs).toBeLessThan(400)
    expect(p.pauseMs).toBeGreaterThan(250)
  })

  it('nothing to read: no reading rather than a guess', () => {
    expect(barPause([{ t: 0, dy: 0 }, { t: 0.03, dy: 0 }], { startT: 0.03, romPx: ROM })).toBeNull()
  })
})
