import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Nothing is emailed in tests: the sender is replaced and its calls read back.
const sent: { to: string; subject: string; body: string }[] = []
vi.mock('./emailService.js', () => ({
  sendTextEmail: vi.fn(async (m: { to: string; subject: string; body: string }) => { sent.push(m); return { ok: true } }),
}))

const { initializeDatabase, getDb } = await import('../db.js')
const { configureSecureStore } = await import('./secureStore.js')
const { createAthlete, updateAthlete } = await import('./athleteService.js')
const { createPayment, todayIso } = await import('./paymentService.js')
const { reminderDraft, sendReminder, ReminderError } = await import('./paymentReminderService.js')

// S5 (D87): a reminder is a draft the coach sends, only for due or overdue payments.

const shift = (days: number) => {
  const d = new Date(`${todayIso()}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

let tmpDir: string
beforeEach(async () => {
  sent.length = 0
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-remind-'))
  configureSecureStore({ safeStorage: null, userDataDir: tmpDir })
  await initializeDatabase(path.join(tmpDir, 'test.sqlite'))
})
afterEach(async () => {
  await getDb().destroy()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

describe('payment reminders', () => {
  it('drafts an overdue reminder in plain words, to the athlete', async () => {
    const a = await createAthlete({ name: 'Åsa Öberg', email: 'asa@example.com' })
    const p = await createPayment({ athlete_id: a.id, amount: 1200, currency: 'sek', paid_through: shift(-3) })
    const d = await reminderDraft(p.id)
    expect(d).toMatchObject({ to: 'asa@example.com', status: 'overdue', remindedAt: null, emailConfigured: false })
    expect(d.subject).toMatch(/^Payment reminder — SEK\s?1,200\.00 was due /)
    expect(d.body).toMatch(/^Hi Åsa,\n\nA friendly reminder that your coaching payment of SEK\s?1,200\.00 was due on /)
  })

  it('a due-soon one says "is due"', async () => {
    const a = await createAthlete({ name: 'Bo', email: 'bo@example.com' })
    const p = await createPayment({ athlete_id: a.id, amount: 100, currency: 'EUR', paid_through: shift(3) })
    expect((await reminderDraft(p.id)).body).toContain('of €100.00 is due on')
  })

  it('refuses a payment that is paid or not due yet', async () => {
    const a = await createAthlete({ name: 'Cy', email: 'cy@example.com' })
    const paid = await createPayment({ athlete_id: a.id, amount: 100, currency: 'EUR', paid_through: shift(30), paid: true })
    const later = await createPayment({ athlete_id: a.id, amount: 100, currency: 'EUR', paid_through: shift(30) })
    await expect(reminderDraft(paid.id)).rejects.toBeInstanceOf(ReminderError)
    await expect(reminderDraft(later.id)).rejects.toMatchObject({ status: 409 })
  })

  it('sends the coach’s edited text and records when', async () => {
    const a = await createAthlete({ name: 'Di', email: 'di@example.com' })
    const p = await createPayment({ athlete_id: a.id, amount: 100, currency: 'EUR', paid_through: shift(-1) })
    expect(await sendReminder(p.id, { subject: 'Quick one', body: 'Hej Di — betalningen?' })).toEqual({ ok: true })
    expect(sent).toEqual([{ to: 'di@example.com', subject: 'Quick one', body: 'Hej Di — betalningen?' }])
    expect((await reminderDraft(p.id)).remindedAt).toBeTruthy()
  })

  it('an athlete with no email gets nothing sent, and the coach is told', async () => {
    const a = await createAthlete({ name: 'Ed' })
    await updateAthlete(a.id, { email: null })
    const p = await createPayment({ athlete_id: a.id, amount: 100, currency: 'EUR', paid_through: shift(-1) })
    expect((await reminderDraft(p.id)).to).toBeNull()
    await expect(sendReminder(p.id, { subject: 's', body: 'b' })).rejects.toMatchObject({ status: 400, message: /Ed has no email address/ })
    expect(sent).toEqual([])
  })
})
