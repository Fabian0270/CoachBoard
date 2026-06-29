import nodemailer from 'nodemailer'
import { getTransportConfig } from './emailSettingsService.js'

// ---------------------------------------------------------------------------
// Sends mail through the coach's own SMTP account (Feature 6a). Errors are
// mapped to distinct, coach-actionable codes so the UI can point at the fix.
// ---------------------------------------------------------------------------

export type SendErrorCode = 'not_configured' | 'auth_failed' | 'no_internet' | 'send_failed'

export type SendResult =
  | { ok: true }
  | { ok: false; status: number; code: SendErrorCode; error: string }

export interface SendProgramEmailInput {
  to: string
  subject: string
  body: string
  attachmentName: string
  attachment: Buffer
}

const NOT_CONFIGURED: SendResult = {
  ok: false,
  status: 400,
  code: 'not_configured',
  error: 'Email is not set up yet. Add your email account in Settings first.',
}

function mapSendError(err: unknown): { code: SendErrorCode; error: string } {
  const e = err as { code?: string; responseCode?: number } | undefined
  const code = e?.code
  if (code === 'EAUTH' || e?.responseCode === 535) {
    return {
      code: 'auth_failed',
      error: 'Email sign-in failed. Check your address and app password in Settings.',
    }
  }
  if (
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNECTION' ||
    code === 'ESOCKET' ||
    code === 'EDNS'
  ) {
    return {
      code: 'no_internet',
      error: 'Could not reach the mail server. Check your internet connection and try again.',
    }
  }
  return { code: 'send_failed', error: 'Failed to send the email. Please try again.' }
}

async function buildTransport() {
  const cfg = await getTransportConfig()
  if (!cfg) return null
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.password },
  })
  const from = cfg.fromName ? `"${cfg.fromName}" <${cfg.user}>` : cfg.user
  return { transport, from, user: cfg.user }
}

export async function sendProgramEmail(input: SendProgramEmailInput): Promise<SendResult> {
  const t = await buildTransport()
  if (!t) return NOT_CONFIGURED
  try {
    await t.transport.sendMail({
      from: t.from,
      to: input.to,
      subject: input.subject,
      text: input.body || undefined,
      attachments: [{ filename: input.attachmentName, content: input.attachment }],
    })
    return { ok: true }
  } catch (err) {
    const { code, error } = mapSendError(err)
    return { ok: false, status: 502, code, error }
  }
}

/** Sends a fixed test message to the coach's own configured address. */
export async function sendTestEmail(): Promise<SendResult> {
  const t = await buildTransport()
  if (!t) return NOT_CONFIGURED
  try {
    await t.transport.sendMail({
      from: t.from,
      to: t.user,
      subject: 'CoachBoard test email',
      text: 'This is a test email from CoachBoard. If you received it, your email settings are working.',
    })
    return { ok: true }
  } catch (err) {
    const { code, error } = mapSendError(err)
    return { ok: false, status: 502, code, error }
  }
}
