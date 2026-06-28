import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { configureSecureStore, type SafeStorageLike } from './secureStore.js'
import { saveSettings } from './emailSettingsService.js'
import { sendProgramEmail } from './emailService.js'

const sendMail = vi.fn()
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail }) },
}))

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
}

let tmpDir: string

beforeEach(() => {
  sendMail.mockReset()
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-email-svc-'))
  configureSecureStore({ safeStorage: fakeSafeStorage, userDataDir: tmpDir })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const configure = () =>
  saveSettings({
    provider: 'gmail', host: 'smtp.gmail.com', port: 465, secure: true,
    user: 'coach@gmail.com', fromName: 'Coach', password: 'pw',
  })

const input = {
  to: 'athlete@example.com',
  subject: 'Your program',
  body: 'hello',
  attachmentName: 'Block 1.xlsx',
  attachment: Buffer.from('xlsx-bytes'),
}

describe('sendProgramEmail', () => {
  it('returns not_configured when no email settings exist', async () => {
    const res = await sendProgramEmail(input)
    expect(res).toMatchObject({ ok: false, code: 'not_configured', status: 400 })
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('sends with the program workbook as the attachment', async () => {
    await configure()
    sendMail.mockResolvedValue({ messageId: '1' })
    const res = await sendProgramEmail(input)
    expect(res.ok).toBe(true)
    const sent = sendMail.mock.calls[0][0]
    expect(sent.to).toBe('athlete@example.com')
    expect(sent.attachments[0]).toMatchObject({ filename: 'Block 1.xlsx' })
    expect(sent.attachments[0].content).toBe(input.attachment)
  })

  it('maps an auth failure to auth_failed', async () => {
    await configure()
    sendMail.mockRejectedValue(Object.assign(new Error('bad creds'), { code: 'EAUTH' }))
    const res = await sendProgramEmail(input)
    expect(res).toMatchObject({ ok: false, code: 'auth_failed' })
  })

  it('maps a network failure to no_internet', async () => {
    await configure()
    sendMail.mockRejectedValue(Object.assign(new Error('dns'), { code: 'ENOTFOUND' }))
    const res = await sendProgramEmail(input)
    expect(res).toMatchObject({ ok: false, code: 'no_internet' })
  })

  it('maps an unknown failure to send_failed', async () => {
    await configure()
    sendMail.mockRejectedValue(new Error('weird'))
    const res = await sendProgramEmail(input)
    expect(res).toMatchObject({ ok: false, code: 'send_failed' })
  })
})
