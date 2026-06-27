import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import ExcelJS from 'exceljs'
import { createApp } from './app.js'
import { initializeDatabase } from './db.js'
import { configureSecureStore, type SafeStorageLike } from './services/secureStore.js'
import { saveSettings } from './services/emailSettingsService.js'

// Capture every outgoing mail so we can compare the emailed attachment against
// the downloaded export (the "no drift" guarantee).
const sendMail = vi.fn()
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }))

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
}

let server: Server
let baseUrl: string
let tmpDir: string
let programId: string

const api = (p: string, init?: RequestInit) => fetch(`${baseUrl}${p}`, {
  headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  ...init,
})
const post = async (p: string, body: unknown) => (await api(p, { method: 'POST', body: JSON.stringify(body) })).json()
const put = (p: string, body: unknown) => api(p, { method: 'PUT', body: JSON.stringify(body) })

beforeAll(async () => {
  await initializeDatabase(':memory:')
  const app = createApp()
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const athlete = await post('/api/athletes', { name: 'Email Owner', email: 'athlete@example.com' })
  const program = await post('/api/programs', { athlete_id: athlete.id, name: 'Email Block', status: 'active' })
  programId = program.id
  await put(`/api/programs/${programId}/duration`, { start_date: '2026-06-08', weeks: 1 })
  const w = await post(`/api/programs/${programId}/workouts`, { name: '2026-06-08', scheduled_date: '2026-06-08' })
  await post(`/api/programs/${programId}/workouts/${w.id}/exercises`, { name: 'Squat', sets: '3', reps: '5', order_index: 0 })
})

afterAll(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))))

beforeEach(() => {
  sendMail.mockReset()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-email-flow-'))
  configureSecureStore({ safeStorage: fakeSafeStorage, userDataDir: tmpDir })
})

describe('POST /api/programs/:id/send-email', () => {
  it('400s when email is not configured', async () => {
    const res = await api(`/api/programs/${programId}/send-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'athlete@example.com', subject: 'Hi' }),
    })
    expect(res.status).toBe(400)
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('400s on an invalid recipient', async () => {
    const res = await api(`/api/programs/${programId}/send-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'not-an-email', subject: 'Hi' }),
    })
    expect(res.status).toBe(400)
  })

  it('emails the same workbook content as the export download (no drift)', async () => {
    await saveSettings({
      provider: 'gmail', host: 'smtp.gmail.com', port: 465, secure: true,
      user: 'coach@gmail.com', fromName: 'Coach', password: 'pw',
    })
    sendMail.mockResolvedValue({ messageId: '1' })

    const exportBuf = Buffer.from(await (await api(`/api/programs/${programId}/export`)).arrayBuffer())

    const res = await api(`/api/programs/${programId}/send-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: 'athlete@example.com', subject: 'Your program', body: 'hi' }),
    })
    expect(res.status).toBe(200)
    expect(sendMail).toHaveBeenCalledTimes(1)
    const attachment = sendMail.mock.calls[0][0].attachments[0].content as Buffer

    // Compare parsed cell values rather than raw bytes: ExcelJS stamps a
    // creation timestamp into the zip, so two renders differ byte-wise even
    // though the content is identical. Equal content == no drift.
    const cells = async (buf: Buffer) => {
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(buf as unknown as ArrayBuffer)
      const out: string[] = []
      wb.worksheets[0].eachRow((row, r) =>
        row.eachCell((cell, c) => out.push(`${r}:${c}=${cell.text}`)),
      )
      return out
    }
    expect(await cells(attachment)).toEqual(await cells(exportBuf))
  })
})
