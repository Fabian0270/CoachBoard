// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import RepTable from './RepTable'
import { renderScreen } from '../../test/render'
import type { Sample } from 'coachboard-shared/videoAnalysis'

// The bench pause in the rep table (BP32, D122-D124): judged only from the bar.

const rep = (index: number, startT: number, barPauseMs?: number) => ({
  index, startT, endT: startT + 0.9, durationMs: 900, romPx: 200, meanVelocityPxS: 150, peakVelocityPxS: 200,
  romM: 0.75, meanVelocity: 0.55, peakVelocity: 0.74, meanPropulsiveVelocity: 0.6, propulsiveFraction: 0.9,
  ...(barPauseMs !== undefined ? { barPauseMs } : {}),
})
// A path with a descent and a held bottom before each rep, so the plate's own pause exists too.
const track: Sample[] = []
for (let i = 0; i <= 240; i++) {
  const t = i / 30
  const k = t % 4
  track.push({ t, x: 300, y: k < 1 ? 140 : k < 2 ? 140 + 200 * (k - 1) : k < 2.8 ? 340 : k < 3.7 ? 340 - 200 * ((k - 2.8) / 0.9) : 140 })
}
const pauseCell = (row: number) => {
  const head = [...document.querySelectorAll('table[aria-label=Reps] thead th')].map((th) => th.textContent?.trim())
  return document.querySelectorAll('table[aria-label=Reps] tbody tr')[row].children[head.indexOf('Pause')].textContent
}

describe('RepTable — the bench pause', () => {
  it('measured on the bar: the figure to the tenth, and the verdict on that figure', () => {
    renderScreen(<RepTable reps={[rep(0, 2.8, 570), rep(1, 6.8, 400), rep(2, 10.8, 0)]} lift="bench-press" metric="mean" calibrated anchors={[]} track={track} />)
    // 0.57 s shows as 0.6 s, and 0.6 s looks good — never "0.6 s borderline".
    expect(pauseCell(0)).toBe('0.6 slooks good')
    expect(pauseCell(1)).toBe('0.4 sborderline')
    // Touch-and-go.
    expect(pauseCell(2)).toBe('0.0 scheck')
  })

  it('a bench not yet measured on the bar: the path figure, greyed, no verdict', () => {
    renderScreen(<RepTable reps={[rep(0, 2.8)]} lift="bench-press" metric="mean" calibrated anchors={[]} track={track} />)
    expect(pauseCell(0)).toMatch(/^\d\.\d s$/)
    expect(screen.queryByText(/looks good|borderline|check/)).toBeNull()
  })

  it('the bar pauses measured on the page are used before the set is saved', () => {
    renderScreen(<RepTable reps={[rep(0, 2.8)]} lift="bench-press" metric="mean" calibrated anchors={[]} track={track} barPauses={new Map([[0, 900]])} />)
    expect(pauseCell(0)).toBe('0.9 slooks good')
  })
})
