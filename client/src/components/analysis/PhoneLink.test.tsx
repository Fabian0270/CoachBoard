// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PhoneLink, { secondsToNextCode } from './PhoneLink'
import type { CameraTake } from './CameraCapture'
import { renderScreen, serve } from '../../test/render'

// BP41 part b (D104–D106): the computer's side of the phone link.

const open = {
  active: true, id: 'visit-1', rotatesAt: null as number | null, rotateEveryMs: null as number | null, phone: null as string | null,
  url: 'http://192.168.1.34:51000/p/abc', otherUrls: ['http://172.20.48.1:51000/p/abc'],
  qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', receiving: null, clip: null, closedBecause: null,
}

describe('Send a set from your phone', () => {
  it('shows the code and the steps, then opens the clip with the athlete, and the lift tapped on the phone', async () => {
    let status: Record<string, unknown> = open
    const server = serve({
      '/api/athletes': { body: [{ id: 'a1', name: 'Sara' }] },
      'POST /api/phone-link': { body: open },
      'GET /api/phone-link': () => ({ body: status }),
      'GET /api/phone-link/clip': { body: 'not really a video' },
      'POST /api/phone-link/claim': { body: { ...open, active: false } },
      'DELETE /api/phone-link': { body: { ...open, active: false } },
    })
    const onDone = vi.fn()
    renderScreen(<PhoneLink onDone={onDone} onCancel={vi.fn()} />)
    expect(await screen.findByAltText('QR code for your phone')).toBeTruthy()
    expect(screen.getByText(/Waiting for your phone/)).toBeTruthy()
    expect(screen.getByText(/same Wi-Fi as this computer/)).toBeTruthy()
    expect(screen.getByText(/Film in 1080p/)).toBeTruthy()
    await userEvent.selectOptions(await screen.findByLabelText('Athlete (optional)'), 'a1')
    // D127: the lift is picked on the phone, not here.
    expect(screen.queryByLabelText('Lift')).toBeNull()
    expect(screen.getByText(/Tap the lift, then/)).toBeTruthy()

    status = { ...open, receiving: 12 * 1024 * 1024 }
    expect(await screen.findByText(/Receiving the clip… 12/, {}, { timeout: 3000 })).toBeTruthy()

    status = { ...open, clip: { name: 'IMG_0042.MOV', bytes: 18, lift: 'deadlift-conventional' } }
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1), { timeout: 3000 })
    const take = onDone.mock.calls[0][0] as CameraTake
    expect(take.file.name).toBe('IMG_0042.MOV')
    expect(take).toMatchObject({ athleteId: 'a1', lift: 'deadlift-conventional' })
    expect(server.calls).toContain('POST /api/phone-link/claim')
  })

  it('leaving closes the link', async () => {
    const server = serve({
      '/api/athletes': { body: [] },
      'POST /api/phone-link': { body: open },
      'GET /api/phone-link': { body: open },
      'DELETE /api/phone-link': { body: { ...open, active: false } },
    })
    const view = renderScreen(<PhoneLink onDone={vi.fn()} onCancel={vi.fn()} />)
    await screen.findByAltText('QR code for your phone')
    view.unmount()
    // Only its own link, by its id — never a newer visit's.
    await waitFor(() => expect(server.calls).toContain('DELETE /api/phone-link?link=visit-1'))
  })

  it('the countdown: whole seconds left, rolling over to the next 45 s once the switch has passed', () => {
    const at = 1_000_000
    expect(secondsToNextCode(at, 45_000, at - 42_300)).toBe(43)
    expect(secondsToNextCode(at, 45_000, at - 1)).toBe(1)
    expect(secondsToNextCode(at, 45_000, at)).toBe(45) // the switch itself: straight to 0:45, never 0:00
    expect(secondsToNextCode(at, 45_000, at + 700)).toBe(45)
    expect(secondsToNextCode(at, 45_000, at + 1_200)).toBe(44)
    expect(secondsToNextCode(at, 45_000, at + 45_000 + 3_000)).toBe(42) // two switches on
    expect(secondsToNextCode(at, null, at + 5_000)).toBe(0)
  })

  it('the countdown ticks on its own clock, not only when the status comes back', async () => {
    const status = { ...open, rotatesAt: Date.now() + 10_400, rotateEveryMs: 45_000 }
    serve({
      '/api/athletes': { body: [] },
      'POST /api/phone-link': { body: status },
      // The status check never comes back: the countdown must keep going anyway.
      'GET /api/phone-link': () => new Promise(() => {}),
      'DELETE /api/phone-link': { body: {} },
    })
    renderScreen(<PhoneLink onDone={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByText('New code in 0:11')).toBeTruthy()
    expect(await screen.findByText('New code in 0:10', {}, { timeout: 1500 })).toBeTruthy()
    expect(await screen.findByText('New code in 0:09', {}, { timeout: 1500 })).toBeTruthy()
  })

  it('shows when the code changes next, then "Phone connected" with a way out if it is not yours (D130)', async () => {
    let status: Record<string, unknown> = { ...open, rotatesAt: Date.now() + 95_000 }
    const server = serve({
      '/api/athletes': { body: [] },
      'POST /api/phone-link': { body: status },
      'GET /api/phone-link': () => ({ body: status }),
      'DELETE /api/phone-link': { body: { ...open, active: false } },
    })
    renderScreen(<PhoneLink onDone={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByText(/New code in 1:3\d/)).toBeTruthy()
    expect(screen.getByText(/Phone won't connect/)).toBeTruthy()
    status = { ...open, phone: '192.168.1.42' }
    expect(await screen.findByText(/Phone connected \(192\.168\.1\.42\)/, {}, { timeout: 3000 })).toBeTruthy()
    // The code has done its job: no QR, no countdown, no typed fallback.
    expect(screen.queryByAltText('QR code for your phone')).toBeNull()
    expect(screen.queryByText(/New code in/)).toBeNull()
    expect(screen.queryByText(/Phone won't connect/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Start again with a new code' }))
    await waitFor(() => expect(server.calls).toContain('DELETE /api/phone-link?link=visit-1'))
    expect(server.calls.filter((c) => c === 'POST /api/phone-link')).toHaveLength(2)
  })

  it('no network a phone can reach: says so, with Try again', async () => {
    serve({
      '/api/athletes': { body: [] },
      'POST /api/phone-link': { status: 400, body: { error: "This computer isn't on a network a phone can reach." } },
      'GET /api/phone-link': { body: { ...open, active: false, qrSvg: null, url: null } },
      'DELETE /api/phone-link': { body: {} },
    })
    renderScreen(<PhoneLink onDone={vi.fn()} onCancel={vi.fn()} />)
    expect((await screen.findByRole('alert')).textContent).toMatch(/isn't on a network a phone can reach/)
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('closed after 30 minutes: says so, with Start again', async () => {
    serve({
      '/api/athletes': { body: [] },
      'POST /api/phone-link': { body: open },
      'GET /api/phone-link': { body: { ...open, active: false, qrSvg: null, closedBecause: 'The phone link closed after 30 minutes with nothing sent.' } },
      'DELETE /api/phone-link': { body: {} },
    })
    renderScreen(<PhoneLink onDone={vi.fn()} onCancel={vi.fn()} />)
    expect(await screen.findByText(/closed after 30 minutes/, {}, { timeout: 3000 })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start again' })).toBeTruthy()
  })
})
