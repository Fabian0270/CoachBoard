// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CameraCapture, { type CameraTake } from './CameraCapture'
import { renderScreen, serve } from '../../test/render'

// BP41 (D100–D103): record a set from a camera, then hand it to the analysis.

vi.mock('./cameraRecording', async (original) => ({
  ...(await original<typeof import('./cameraRecording')>()),
  // mediabunny's rewrite needs WebCodecs-era APIs jsdom lacks; the real one is checked in the packaged app.
  finishRecording: vi.fn(async (blob: Blob, name: string) => new File([blob], name, { type: 'video/webm' })),
}))

const track = { stop: vi.fn(), getSettings: () => ({ width: 1280, height: 720, frameRate: 30, deviceId: 'cam1' }) }
const stream = { getTracks: () => [track], getVideoTracks: () => [track] }

class FakeRecorder {
  static isTypeSupported = () => true
  static last: FakeRecorder | null = null
  state = 'inactive'
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(public stream: unknown, public opts: unknown) { FakeRecorder.last = this }
  start() { this.state = 'recording' }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['frames'], { type: 'video/webm' }) })
    this.onstop?.()
  }
}

const camera = (impl?: () => Promise<unknown>) => {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(impl ?? (async () => stream)),
      enumerateDevices: vi.fn(async () => [
        { kind: 'videoinput', deviceId: 'cam1', label: 'Logitech C920' },
        { kind: 'videoinput', deviceId: 'cam2', label: 'Phone (Camo)' },
      ]),
    },
  })
}

beforeEach(() => {
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  track.stop.mockClear()
  try { localStorage.clear() } catch { /* fine */ }
  serve({ '/api/athletes': { body: [{ id: 'a1', name: 'Sara' }] } })
})

const open = (onDone = vi.fn(), onCancel = vi.fn()) => {
  renderScreen(<CameraCapture onDone={onDone} onCancel={onCancel} />)
  return { onDone, onCancel }
}

describe('Record a set from a camera', () => {
  it('shows what the camera gives, records, and hands the clip over with the athlete and lift', async () => {
    camera()
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    const { onDone } = open()
    expect(await screen.findByText(/1280 × 720 · 30 frames a second/)).toBeTruthy()
    // More than one camera: a choice, the one in use selected.
    expect((screen.getByLabelText('Camera') as HTMLSelectElement).value).toBe('cam1')
    await userEvent.selectOptions(await screen.findByLabelText('Athlete (optional)'), 'a1')
    // D127: no lift is picked to start with, and Record waits for one.
    expect(screen.queryAllByRole('button', { pressed: true })).toHaveLength(0)
    expect((screen.getByRole('button', { name: /Record/ }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Pick the lift above first/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Bench press' }))
    expect(screen.getByRole('button', { name: 'Bench press', pressed: true })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Record/ }))
    expect(screen.getByRole('button', { name: /Stop/ })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Stop/ }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    const take = onDone.mock.calls[0][0] as CameraTake
    expect(take.file.name).toMatch(/^camera-\d{4}-\d{2}-\d{2}-\d{4}\.webm$/)
    expect(take).toMatchObject({ athleteId: 'a1', lift: 'bench-press' })
    // The camera is let go once the clip is handed over.
    expect(track.stop).toHaveBeenCalled()
  })

  it('Space starts and stops, but not while choosing something', async () => {
    camera()
    const { onDone } = open()
    await screen.findByText(/frames a second/)
    ;(document.activeElement as HTMLElement | null)?.blur()
    // No lift yet (D127): Space does nothing.
    await userEvent.keyboard(' ')
    expect(screen.queryByRole('button', { name: /Stop/ })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Back squat' }))
    ;(document.activeElement as HTMLElement | null)?.blur()
    await userEvent.keyboard(' ')
    expect(screen.getByRole('button', { name: /Stop/ })).toBeTruthy()
    // In a dropdown, Space belongs to the dropdown.
    screen.getByLabelText('Athlete (optional)').focus()
    await userEvent.keyboard(' ')
    expect(screen.getByRole('button', { name: /Stop/ })).toBeTruthy()
    ;(document.activeElement as HTMLElement).blur()
    await userEvent.keyboard(' ')
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
  })

  it('going back mid-recording keeps nothing', async () => {
    camera()
    const { onDone, onCancel } = open()
    await screen.findByText(/frames a second/)
    await userEvent.click(screen.getByRole('button', { name: 'Deadlift — conventional' }))
    await userEvent.click(screen.getByRole('button', { name: /Record/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onCancel).toHaveBeenCalled()
    expect(onDone).not.toHaveBeenCalled()
    expect(track.stop).toHaveBeenCalled()
  })

  it('no camera: says what to do', async () => {
    camera(async () => { throw Object.assign(new Error('none'), { name: 'NotFoundError' }) })
    open()
    expect((await screen.findByRole('alert')).textContent).toMatch(/No camera found.*phone as a webcam/)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Record/ })).toBeNull()
  })

  it('camera refused, or busy in another app: says which', async () => {
    camera(async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }) })
    open()
    expect((await screen.findByRole('alert')).textContent).toMatch(/not allowed to use the camera/)
  })
})
