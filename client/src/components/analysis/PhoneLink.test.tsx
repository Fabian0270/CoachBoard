// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import PhoneLink from './PhoneLink'
import type { CameraTake } from './CameraCapture'
import { renderScreen, serve } from '../../test/render'

// BP41 part b (D104–D106): the computer's side of the phone link.

const open = {
  active: true, url: 'http://192.168.1.34:51000/p/abc', otherUrls: ['http://172.20.48.1:51000/p/abc'],
  qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', receiving: null, clip: null, closedBecause: null,
}

describe('Send a set from your phone', () => {
  it('shows the code and the steps, then opens the clip with the athlete and lift when it arrives', async () => {
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
    await userEvent.selectOptions(screen.getByLabelText('Lift'), 'deadlift-conventional')

    status = { ...open, receiving: 12 * 1024 * 1024 }
    expect(await screen.findByText(/Receiving the clip… 12/, {}, { timeout: 3000 })).toBeTruthy()

    status = { ...open, clip: { name: 'IMG_0042.MOV', bytes: 18 } }
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
    await waitFor(() => expect(server.calls).toContain('DELETE /api/phone-link'))
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
