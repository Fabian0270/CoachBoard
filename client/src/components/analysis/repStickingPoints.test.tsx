// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { repStickingPoints, type Sample } from 'coachboard-shared/videoAnalysis'
import BarSpeedChart from './BarSpeedChart'
import { renderScreen } from '../../test/render'

// Each rep's sticking point (BP11): where it slowed most on the way up.

const FPS = 60
/** A still bottom for a second, a 1.5 s way up with this speed profile (px/s), then still at the top. */
function trackWith(speed: (tau: number) => number): Sample[] {
  const out: Sample[] = []
  let y = 500
  for (let i = 0; i <= 4 * FPS; i++) {
    const t = i / FPS
    const tau = t - 1
    if (tau > 0 && tau <= 1.5) y -= speed(tau) / FPS
    out.push({ t, x: 300, y })
  }
  return out
}
const bell = (tau: number) => 300 * Math.sin((Math.PI * tau) / 1.5) ** 2
const dipAt = 0.6
const stalling = (tau: number) => bell(tau) * (1 - 0.85 * Math.exp(-(((tau - dipAt) / 0.1) ** 2)))

describe('repStickingPoints', () => {
  it('where a rep slowed most, and how far up it was', () => {
    const track = trackWith(stalling)
    const rep = { startT: 1, endT: 2.5 }
    const [p] = repStickingPoints(track, [rep])
    expect(p).not.toBeNull()
    expect(p!.t).toBeCloseTo(1 + dipAt, 1)
    // How far the bar had travelled by then, against the whole rep.
    const bottom = track[FPS].y
    const top = track[Math.round(2.5 * FPS)].y
    const at = track.find((s) => s.t >= 1 + dipAt)!.y
    expect(Math.abs(p!.height - (bottom - at) / (bottom - top))).toBeLessThan(0.05)
  })

  it('nothing for a rep that sped up and slowed into lockout without a dip', () => {
    expect(repStickingPoints(trackWith(bell), [{ startT: 1, endT: 2.5 }])).toEqual([null])
  })

  it('a bar that stalls dead mid-rep is still a sticking point', () => {
    const dead = (tau: number) => (Math.abs(tau - dipAt) < 0.05 ? 0 : bell(tau))
    const [p] = repStickingPoints(trackWith(dead), [{ startT: 1, endT: 2.5 }])
    expect(p).not.toBeNull()
    expect(Math.abs(p!.t - (1 + dipAt))).toBeLessThan(0.1)
  })
})

describe('BarSpeedChart', () => {
  it('names each rep that stuck and how far up', () => {
    renderScreen(<BarSpeedChart track={trackWith(stalling)} reps={[{ startT: 1, endT: 2.5 }]} pixelsPerMetre={400} />)
    expect(screen.getByText(/rep 1 at \d+%/)).toBeTruthy()
  })

  it('says so when no rep stuck', () => {
    renderScreen(<BarSpeedChart track={trackWith(bell)} reps={[{ startT: 1, endT: 2.5 }]} pixelsPerMetre={null} />)
    expect(screen.getByText(/no sticking point/)).toBeTruthy()
    expect(screen.getByText(/pixels\/second/)).toBeTruthy()
  })
})
