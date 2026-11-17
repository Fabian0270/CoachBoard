import { describe, expect, it } from 'vitest'
import { repTempos, type Sample } from 'coachboard-shared/videoAnalysis'

// Tempo per rep (BP12): the way down and the pause at the bottom.

const FPS = 30
/**
 * Standing at the top (y 140) for `stand` s, down to y 340 over `down` s, a
 * pause of `pause` s, up over 0.9 s; `reps` times. Returns the track and each
 * rep's start up and top, as repMetrics would report them.
 */
function squat({ stand = 0.6, down = 1.2, pause = 0.5, reps = 2 } = {}) {
  const cycle = down + pause + 0.9 + stand
  const yAt = (t: number) => {
    if (t < stand) return 140
    const k = (t - stand) % cycle
    if (k < down) return 140 + 200 * (k / down)
    if (k < down + pause) return 340
    if (k < down + pause + 0.9) return 340 - 200 * ((k - down - pause) / 0.9)
    return 140
  }
  const track: Sample[] = []
  for (let i = 0; i <= Math.ceil((stand + cycle * reps) * FPS); i++) track.push({ t: i / FPS, x: 300, y: yAt(i / FPS) })
  const metrics = Array.from({ length: reps }, (_, i) => {
    const startT = stand + i * cycle + down + pause
    return { startT, endT: startT + 0.9, romPx: 200 }
  })
  return { track, metrics }
}

describe('repTempos', () => {
  it('the way down and the pause at the bottom, per rep', () => {
    const { track, metrics } = squat({ down: 1.2, pause: 0.5 })
    const tempos = repTempos(track, metrics)
    expect(tempos).toHaveLength(2)
    for (const t of tempos) {
      expect(t).not.toBeNull()
      expect(Math.abs(t!.descentMs - 1200)).toBeLessThan(150)
      expect(Math.abs(t!.pauseMs - 500)).toBeLessThan(150)
    }
  })

  it('touch-and-go reads as next to no pause', () => {
    const { track, metrics } = squat({ down: 0.8, pause: 0 })
    for (const t of repTempos(track, metrics)) {
      expect(t).not.toBeNull()
      expect(t!.pauseMs).toBeLessThan(150)
      expect(Math.abs(t!.descentMs - 800)).toBeLessThan(150)
    }
  })

  it('nothing for a first pull that starts on the floor', () => {
    // A deadlift: at the bottom from the start, then up.
    const track: Sample[] = []
    for (let i = 0; i <= 3 * FPS; i++) {
      const t = i / FPS
      track.push({ t, x: 300, y: t < 1 ? 340 : t < 1.9 ? 340 - 200 * ((t - 1) / 0.9) : 140 })
    }
    expect(repTempos(track, [{ startT: 1, endT: 1.9, romPx: 200 }])).toEqual([null])
  })

  it('keeps the order it was given', () => {
    const { track, metrics } = squat({ down: 1.2, pause: 0.5 })
    const reversed = [...metrics].reverse()
    expect(repTempos(track, reversed)).toEqual([...repTempos(track, metrics)].reverse())
  })
})
