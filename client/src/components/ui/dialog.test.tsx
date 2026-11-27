// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Dialog, DialogContent, DialogTitle } from './dialog'
import SendProgramDialog from '../SendProgramDialog'
import { renderScreen, serve } from '../../test/render'

// ---------------------------------------------------------------------------
// Where the cursor goes when a dialog closes.
//
// Radix only returns focus to a DialogTrigger. The app opens dialogs from
// plain buttons, menus and shortcuts, so closing one dropped the cursor on the
// page itself (measured in the packaged build for six of the program page's
// dialogs) and Tab started again from the top.
// ---------------------------------------------------------------------------

function Page() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button">First</button>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      {/* Mounted while closed, like most of the app's dialogs. */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Example</DialogTitle>
          <input aria-label="Field" />
        </DialogContent>
      </Dialog>
    </>
  )
}

describe('DialogContent — focus', () => {
  it('puts the cursor back on what opened it, every time it closes', async () => {
    render(<Page />)
    const opener = screen.getByRole('button', { name: 'Open' })
    for (let round = 0; round < 2; round++) {
      opener.focus()
      await userEvent.keyboard('{Enter}')
      await screen.findByRole('dialog')
      expect(document.activeElement).toBe(screen.getByLabelText('Field'))
      await userEvent.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      await waitFor(() => expect(document.activeElement).toBe(opener))
    }
  })
})

describe('Email dialog — focus', () => {
  it('puts the cursor on the recipient once the form has loaded, not on Send', async () => {
    serve({
      '/api/settings/email': { body: { configured: true } },
      '/api/athletes/a1': { body: { id: 'a1', email: 'sara@example.com' } },
    })
    renderScreen(
      <SendProgramDialog open onOpenChange={() => {}} programId="p1" programName="Block" athleteId="a1" />,
    )
    const to = await screen.findByLabelText(/To/)
    await waitFor(() => expect(document.activeElement).toBe(to))
  })
})
