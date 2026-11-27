import { describe, expect, it } from 'vitest'
import { feedbackMessage } from './feedbackMessage'

// The feedback message for the athlete (BP36).

const rep = (index: number, startT: number, mean: number) => ({
  index, startT, endT: startT + 1, durationMs: 1000, romPx: 200, meanVelocityPxS: mean * 200, peakVelocityPxS: mean * 260,
  romM: 1, meanVelocity: mean, peakVelocity: mean * 1.3, meanPropulsiveVelocity: null, propulsiveFraction: null,
})
// Rep 2 (t 3–4) strays 12 px = 6 cm sideways at 200 px/m; rep 1 stays put.
const track = Array.from({ length: 51 }, (_, i) => {
  const t = i / 10
  return { t, x: t >= 3 && t <= 4 ? 300 + (t - 3) * 12 : 300, y: 200 }
})

describe('feedbackMessage', () => {
  it('the set, the last rep, the notable drift, then the note', () => {
    const msg = feedbackMessage({
      lift: 'back-squat', loadKg: 150, reps: [rep(1, 3, 0.31), rep(0, 1, 0.5)], metric: 'mean', rpe: 8.5,
      track, pixelsPerMetre: 200, note: 'Chest up out of the hole.',
    })
    expect(msg).toBe('Back squat 150 kg — 2 reps. Last rep 0.31 m/s, about RPE 8.5. The bar strayed 6 cm sideways on rep 2.\n\nChest up out of the hole.')
  })

  it('without a scale: no speeds, no drift', () => {
    const raw = { ...rep(0, 1, 0.5), meanVelocity: null, peakVelocity: null, romM: null }
    expect(feedbackMessage({ lift: null, loadKg: null, reps: [raw], metric: 'mean', rpe: null, track, pixelsPerMetre: null, note: null })).toBe('1 rep.')
  })
})
