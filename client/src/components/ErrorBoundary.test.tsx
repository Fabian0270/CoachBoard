// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ErrorBoundary from './ErrorBoundary'
import { serve } from '../test/render'

/** What an async handler with no catch produces in the browser. */
function rejectInBackground(reason: unknown): void {
  const event = new Event('unhandledrejection') as Event & { reason: unknown }
  event.reason = reason
  act(() => { window.dispatchEvent(event) })
}

describe('ErrorBoundary', () => {
  it('keeps the screen up for a failed background action and lets the coach dismiss the notice', async () => {
    serve({})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary><p>Recording in progress</p></ErrorBoundary>)

    rejectInBackground(new Error('Could not save the clip'))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/Could not save the clip/)).toBeTruthy()
    // The whole point: one missing catch used to unmount everything, an
    // in-progress recording included.
    expect(screen.getByText('Recording in progress')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Recording in progress')).toBeTruthy()
  })

  it('replaces the screen when it cannot be drawn at all', async () => {
    serve({})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    function Broken(): never {
      throw new Error('cannot draw this')
    }
    // React re-reports a caught render error to window in development; that is
    // the error this test throws on purpose, so keep it out of the run's output.
    const quiet = (e: ErrorEvent) => e.preventDefault()
    window.addEventListener('error', quiet)
    try {
      render(<ErrorBoundary><Broken /></ErrorBoundary>)
      expect(await screen.findByText(/hit an error it could not recover from/)).toBeTruthy()
      expect(screen.getByText('cannot draw this')).toBeTruthy()
    } finally {
      window.removeEventListener('error', quiet)
    }
  })
})
