// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LiftPrompt from './LiftPrompt'
import { renderScreen } from '../../test/render'

// D126: the lift is asked first thing when a clip is opened.

describe('LiftPrompt', () => {
  it('offers every lift, and the click is the answer', async () => {
    const onPick = vi.fn()
    renderScreen(<LiftPrompt known={null} onPick={onPick} />)
    for (const name of ['Back squat', 'Bench press', 'Deadlift — conventional', 'Other']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
    // Nothing is picked out when the clip says nothing.
    expect(screen.queryAllByRole('button', { pressed: true })).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Bench press' }))
    expect(onPick).toHaveBeenCalledWith('bench-press')
  })

  it('a lift the clip already names is picked out, and one click confirms it', async () => {
    const onPick = vi.fn()
    renderScreen(<LiftPrompt known={{ lift: 'bench-press', from: 'caption' }} onPick={onPick} />)
    expect(screen.getByRole('button', { name: 'Bench press', pressed: true })).toBeTruthy()
    expect(screen.getByText(/from the caption/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Bench press' }))
    expect(onPick).toHaveBeenCalledWith('bench-press')
  })
})
