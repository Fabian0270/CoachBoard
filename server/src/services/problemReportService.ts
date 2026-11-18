import fs from 'fs'
import os from 'os'
import JSZip from 'jszip'
import { appVersion, logFilePath } from './systemService.js'
import { getSettings } from './emailSettingsService.js'
import { sendAttachmentEmail, MAX_ATTACHMENT_BYTES, type SendResult } from './emailService.js'

// ---------------------------------------------------------------------------
// "Report a problem" (S4, D81–D83).
//
// One .zip: what the coach wrote, the app version and OS, the end of the app
// log, and — only when they ticked it — the Excel file that failed to import.
// Never the database. Emailed to the support address over the coach's own
// email setup; without one, the same .zip is handed back for them to save and
// send themselves.
// ---------------------------------------------------------------------------

/** Where reports go (D81: Fabian's choice). */
export const SUPPORT_ADDRESS = 'fabianolsson28@gmail.com'

/** How much of the end of the log goes in (D82). */
export const LOG_TAIL_BYTES = 2 * 1024 * 1024

export interface ReportInput {
  description: string
  /** The file that failed to import, when the coach chose to include it. */
  file?: { name: string; content: Buffer } | null
}

export interface ReportPreview {
  version: string | null
  os: string
  logBytes: number
  emailConfigured: boolean
  supportAddress: string
}

function osLabel(): string {
  return `${os.type()} ${os.release()} (${process.platform} ${process.arch})`
}

/** The last `LOG_TAIL_BYTES` of the log, reaching into the rolled-over file when the current one is short. */
export function logTail(): Buffer {
  const current = logFilePath()
  const parts: Buffer[] = []
  let room = LOG_TAIL_BYTES
  for (const file of [current, `${current}.1`]) {
    if (room <= 0 || !fs.existsSync(file)) continue
    const size = fs.statSync(file).size
    const take = Math.min(size, room)
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(take)
      fs.readSync(fd, buf, 0, take, size - take)
      parts.unshift(buf)
    } finally {
      fs.closeSync(fd)
    }
    room -= take
  }
  return Buffer.concat(parts)
}

export async function reportPreview(): Promise<ReportPreview> {
  const settings = await getSettings()
  return {
    version: appVersion(),
    os: osLabel(),
    logBytes: Math.min(LOG_TAIL_BYTES, logTail().length),
    emailConfigured: !!settings,
    supportAddress: SUPPORT_ADDRESS,
  }
}

/** A file name safe to put in a zip and an email: no folders, no odd characters. */
const safeName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120) || 'file'

export async function buildReport(input: ReportInput, now = new Date()): Promise<{ zip: Buffer; name: string }> {
  const zip = new JSZip()
  const lines = [
    'CoachBoard problem report',
    `Date: ${now.toISOString()}`,
    `Version: ${appVersion() ?? 'unknown'}`,
    `System: ${osLabel()}`,
    input.file ? `Attached file: ${safeName(input.file.name)} (${input.file.content.length} bytes)` : 'Attached file: none',
    '',
    'What happened:',
    input.description.trim() || '(nothing written)',
    '',
  ]
  zip.file('report.txt', lines.join('\n'))
  zip.file('coachboard.log', logTail())
  if (input.file) zip.file(`file/${safeName(input.file.name)}`, input.file.content)
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const stamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-')
  return { zip: buffer, name: `coachboard-report-${stamp}.zip` }
}

export type SendReportResult = SendResult | { ok: false; status: number; code: 'too_big'; error: string }

/** Emails the report to the support address. The caller falls back to saving it when email is not set up. */
export async function sendReport(input: ReportInput): Promise<SendReportResult> {
  const { zip, name } = await buildReport(input)
  if (zip.length > MAX_ATTACHMENT_BYTES) {
    return { ok: false, status: 400, code: 'too_big', error: 'The report is too big to email. Save it instead and send it another way.' }
  }
  const first = input.description.trim().split('\n')[0]?.slice(0, 80)
  return sendAttachmentEmail({
    to: SUPPORT_ADDRESS,
    subject: `CoachBoard problem report — ${appVersion() ?? 'unknown version'}${first ? ` — ${first}` : ''}`,
    body: `${input.description.trim() || '(nothing written)'}\n\nVersion: ${appVersion() ?? 'unknown'}\nSystem: ${osLabel()}\n`,
    attachmentName: name,
    attachment: zip,
  })
}
