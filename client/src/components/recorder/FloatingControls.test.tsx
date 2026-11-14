// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FloatingControls from './FloatingControls'
import { CONTROLS_CHANNEL, type ControlsMessage } from './controlsChannel'

// The bar is a separate window that only mirrors the recorder in the main
// window and sends commands back over a BroadcastChannel. This plays the
// recorder's side of that channel.

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function recorderSide() {
  const channel = new BroadcastChannel(CONTROLS_CHANNEL)
  const received: ControlsMessage[] = []
  channel.onmessage = (e: MessageEvent<ControlsMessage>) => received.push(e.data)
  const publish = (state: ControlsMessage & { type: 'state' }) => act(async () => {
    channel.postMessage(state)
    await new Promise((r) => setTimeout(r, 20))
  })
  return { channel, received, publish }
}

describe('floating recording controls', () => {
  it('asks for the state on open, then shows the recorder’s time', async () => {
    const recorder = recorderSide()
    render(<FloatingControls />)
    await vi.waitFor(() => expect(recorder.received).toContainEqual({ type: 'hello' }))

    await recorder.publish({ type: 'state', state: 'recording', elapsedMs: 65_000, bytes: 0 })
    expect(screen.getByText('1:05')).toBeTruthy()
    expect(screen.getByText('Recording')).toBeTruthy()
    recorder.channel.close()
  })

  it('sends pause, resume and stop back to the recorder', async () => {
    const recorder = recorderSide()
    render(<FloatingControls />)
    await recorder.publish({ type: 'state', state: 'recording', elapsedMs: 1000, bytes: 0 })

    await userEvent.click(screen.getByRole('button', { name: 'Pause recording' }))
    await recorder.publish({ type: 'state', state: 'paused', elapsedMs: 1000, bytes: 0 })
    expect(screen.getByText('Paused')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Resume recording' }))
    await userEvent.click(screen.getByRole('button', { name: 'Stop recording' }))

    await vi.waitFor(() =>
      expect(recorder.received.filter((m) => m.type === 'command')).toEqual([
        { type: 'command', action: 'pause' },
        { type: 'command', action: 'resume' },
        { type: 'command', action: 'stop' },
      ]),
    )
    recorder.channel.close()
  })

  it('closes itself when the recording is over', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    const recorder = recorderSide()
    render(<FloatingControls />)
    await recorder.publish({ type: 'state', state: 'recording', elapsedMs: 1000, bytes: 0 })
    expect(close).not.toHaveBeenCalled()
    await recorder.publish({ type: 'state', state: 'finalizing', elapsedMs: 1000, bytes: 0 })
    expect(close).toHaveBeenCalled()
    recorder.channel.close()
  })

  it('closes itself if the main window stops answering', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const close = vi.spyOn(window, 'close').mockImplementation(() => {})
    render(<FloatingControls />)
    await act(async () => {
      vi.advanceTimersByTime(5000)
    })
    expect(close).toHaveBeenCalled()
    vi.useRealTimers()
  })
})
