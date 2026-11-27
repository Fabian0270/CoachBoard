// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderScreen, serve } from '../test/render'
import ReportProblemDialog from './ReportProblemDialog'

// S4 (D81–D83): the coach sees what goes in, and it goes by email when it can.

const preview = (emailConfigured: boolean) => ({
  body: { version: '1.18.0', os: 'Windows_NT 10.0 (win32 x64)', logBytes: 300_000, emailConfigured, supportAddress: 'support@example.com' },
})
const posted = (suffix: string) =>
  (globalThis.fetch as unknown as { mock: { calls: [unknown, RequestInit?][] } }).mock.calls
    .filter(([url, init]) => init?.method === 'POST' && String(url).endsWith(suffix))
    .map(([, init]) => JSON.parse(String(init?.body)))

describe('ReportProblemDialog', () => {
  it('lists what goes in, and sends it with the failing file when ticked', async () => {
    serve({ '/api/support/report': preview(true), 'POST /api/support/report/send': { body: { ok: true } } })
    const file = new File(['sheet bytes'], 'Block 3.xlsx')
    renderScreen(<ReportProblemDialog open onOpenChange={() => {}} file={file} initialDescription="Import said no Sets column" />)
    expect(await screen.findByText(/CoachBoard 1.18.0 on Windows/)).toBeTruthy()
    expect(screen.getByText(/The end of the app’s log \(293 KB\)/)).toBeTruthy()
    expect(screen.getByText(/Sent from your email to support@example.com/)).toBeTruthy()
    expect((screen.getByLabelText('What happened') as HTMLTextAreaElement).value).toBe('Import said no Sets column')
    await userEvent.click(screen.getByRole('button', { name: /Send report/ }))
    await waitFor(() => expect(posted('/report/send')).toHaveLength(1))
    expect(posted('/report/send')[0]).toEqual({
      description: 'Import said no Sets column',
      file: { name: 'Block 3.xlsx', base64: btoa('sheet bytes') },
    })
  })

  it('leaves the file out when unticked', async () => {
    serve({ '/api/support/report': preview(true), 'POST /api/support/report/send': { body: { ok: true } } })
    renderScreen(<ReportProblemDialog open onOpenChange={() => {}} file={new File(['x'], 'a.xlsx')} />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /The file that failed: a.xlsx/ }))
    await userEvent.click(screen.getByRole('button', { name: /Send report/ }))
    await waitFor(() => expect(posted('/report/send')).toHaveLength(1))
    expect(posted('/report/send')[0].file).toBeNull()
  })

  it('without email set up, offers only saving, and says where to send it', async () => {
    serve({ '/api/support/report': preview(false) })
    renderScreen(<ReportProblemDialog open onOpenChange={() => {}} />)
    expect(await screen.findByText(/saved as a .zip for you to email to support@example.com/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Send report/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Save as .zip/ })).toBeTruthy()
  })
})
