// @vitest-environment jsdom
import { afterEach, describe, it, expect } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import VelocityTargetLine, { tableTarget, useSetTarget } from './VelocityTarget'
import RepTable from './RepTable'
import type { RepMetrics } from 'coachboard-shared/videoAnalysis'

// BP39 (D74, D75): a set linked to a row with a velocity target, judged.

const rep = (index: number, mean: number): RepMetrics => ({
  index, startT: index * 3, endT: index * 3 + 1, durationMs: 1000, romPx: 100, meanVelocityPxS: mean * 200, peakVelocityPxS: mean * 260,
  romM: 0.5, meanVelocity: mean, peakVelocity: mean * 1.3, meanPropulsiveVelocity: null, propulsiveFraction: null,
})
const SET = [rep(0, 0.6), rep(1, 0.58), rep(2, 0.52), rep(3, 0.47), rep(4, 0.44)]

afterEach(cleanup)

function Page({ text, reps = SET, calibrated = true }: { text: string | null; reps?: RepMetrics[]; calibrated?: boolean }) {
  const t = useSetTarget(text, reps, 'mean', calibrated)
  return (
    <>
      <VelocityTargetLine setTarget={t} rowName="Squat" calibrated={calibrated} />
      <RepTable reps={reps} lift="back-squat" metric="mean" calibrated={calibrated} anchors={[]} target={tableTarget(t)} />
    </>
  )
}

describe('the velocity target on the bar path pages', () => {
  it('says how many reps met the speed and where the loss cut-off was reached', () => {
    render(<Page text="0.50 · VL 20%" />)
    const line = screen.getByLabelText('Velocity target')
    expect(line.textContent).toContain('Target from Squat: 0.50 m/s or faster · stop at 20 % loss')
    expect(line.textContent).toContain('Speed: 3 of 5 reps at 0.50 m/s or faster — slowest 0.44.')
    expect(line.textContent).toContain('Velocity loss: reached 20 % at rep 4 — 1 rep after the cut-off.')
  })

  it('marks each rep in the Target column', () => {
    render(<Page text="0.50 · VL 20%" />)
    const rows = within(screen.getByRole('table', { name: 'Reps' })).getAllByRole('row').slice(1)
    const cell = (i: number) => rows[i].querySelectorAll('td')[rows[i].querySelectorAll('td').length - 1].textContent
    expect(cell(0)).toBe('−0 %on target')
    expect(cell(3)).toBe('−22 %under targetcut-off reached')
    expect(cell(4)).toBe('−27 %under targetpast cut-off')
  })

  it('all reps inside, cut-off never reached', () => {
    render(<Page text="0.40 · VL 30%" />)
    const line = screen.getByLabelText('Velocity target').textContent
    expect(line).toContain('Speed: all 5 reps at 0.40 m/s or faster.')
    expect(line).toContain('Velocity loss: never reached 30 % (most 27 %).')
  })

  it('a range marks the too-fast reps', () => {
    render(<Page text="0.45-0.55" />)
    expect(screen.getByLabelText('Velocity target').textContent).toContain('2 of 5 reps inside 0.45–0.55 m/s')
    expect(screen.getAllByText('over range')).toHaveLength(2)
  })

  it('without a scale, asks for one and adds no column', () => {
    render(<Page text="0.50" calibrated={false} />)
    expect(screen.getByText(/Draw the scale to judge the set/)).toBeTruthy()
    expect(screen.queryByText('Target', { selector: 'th' })).toBeNull()
  })

  it('a cell it cannot read says so', () => {
    render(<Page text="fast" />)
    expect(screen.getByText(/reads “fast”, which is not a speed or a loss cut-off/)).toBeTruthy()
  })

  it('no target, nothing shown', () => {
    const { container } = render(<Page text={null} />)
    expect(container.querySelector('[aria-label="Velocity target"]')).toBeNull()
    expect(screen.queryByText('Target', { selector: 'th' })).toBeNull()
  })
})
