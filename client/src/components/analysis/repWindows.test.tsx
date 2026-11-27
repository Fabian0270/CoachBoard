// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { repWindows } from './AnalysisStage'
import RepTable from './RepTable'
import PathPlot from './PathPlot'
import { renderScreen } from '../../test/render'

// Reps apart (BP9) and laid over each other beside the video (BP10).

describe('repWindows', () => {
  it('each rep runs from the top before it, down to its bottom and back up', () => {
    // Concentrics (bottom → top) at 1.8–2.7 and 4.4–5.3; the path starts at 0.
    expect(repWindows([{ startT: 4.4, endT: 5.3 }, { startT: 1.8, endT: 2.7 }], 0)).toEqual([
      { from: 0, bottom: 1.8, to: 2.7 },
      { from: 2.7, bottom: 4.4, to: 5.3 },
    ])
  })
})

const rep = (index: number, startT: number) => ({
  index, startT, endT: startT + 0.9, durationMs: 900, romPx: 200, meanVelocityPxS: 150, peakVelocityPxS: 200,
  romM: 0.75, meanVelocity: 0.55, peakVelocity: 0.74, meanPropulsiveVelocity: 0.6, propulsiveFraction: 0.9,
})

describe('RepTable — jump to a rep', () => {
  it('the rep number jumps the video there', async () => {
    const onJump = vi.fn()
    renderScreen(<RepTable reps={[rep(0, 1.8), rep(1, 4.4)]} lift="back-squat" metric="mean" calibrated anchors={[]} onJump={onJump} />)
    await userEvent.click(screen.getByRole('button', { name: 'Jump to rep 2' }))
    expect(onJump).toHaveBeenCalledWith(1)
  })
})

describe('PathPlot — reps laid over each other', () => {
  it('says which rep is picked out', () => {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never
    const track = Array.from({ length: 200 }, (_, i) => ({ t: i / 30, x: 300, y: 100 + (i % 78) }))
    renderScreen(<PathPlot track={track} color="#34d399" reps={[rep(0, 1.8), rep(1, 4.4)]} currentTime={4.8} />)
    expect(screen.getByText(/2 reps laid over each other from one start, rep 2 picked out/)).toBeTruthy()
  })
})
