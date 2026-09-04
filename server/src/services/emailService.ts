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

/**
 * Practical ceiling for one attachment.
 *
 * Providers advertise 25 MB, but MIME encodes attachments in base64, which
 * inflates them by about a third — so a 25 MB file is not a 25 MB message, and
 * the bounce arrives long after the coach thinks the video is on its way. 20 MB
 * is the largest file that reliably survives that inflation.
 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

export const ATTACHMENT_TOO_BIG: Extract<SendResult, { ok: false }> = {
  ok: false,
  status: 400,
  code: 'send_failed',
  error:
    'This recording is too big to email. Save it to your PC and share it from there instead.',
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

/**
 * Sends one file to one address.
 *
 * Named for what it does rather than for the program export it was written for,
 * because feedback recordings (Feature 11c) need exactly the same thing and
 * duplicating the transport, the from-header and the error mapping to say
 * "video" instead of "program" would be three places to fix a bug instead of
 * one.
 */
export async function sendAttachmentEmail(input: SendProgramEmailInput): Promise<SendResult> {
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

/** The program export's own name for the above. Unchanged behaviour. */
export const sendProgramEmail = sendAttachmentEmail

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
