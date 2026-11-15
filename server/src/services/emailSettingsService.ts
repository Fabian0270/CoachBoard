import fs from 'fs/promises'
import path from 'path'
import {
  userDataDir,
  encryptToBase64,
  decryptFromBase64,
  encryptionAvailable,
} from './secureStore.js'
import { createUpdateQueue, writeFileAtomic } from '../lib/atomicFile.js'

// ---------------------------------------------------------------------------
// Coach email (SMTP) settings — persisted to a JSON file in userData. The app
// password is stored as a safeStorage-encrypted base64 blob, never plaintext
// and never in the SQLite DB (Feature 6a).
// ---------------------------------------------------------------------------

export type EmailProvider = 'gmail' | 'outlook' | 'custom'

interface StoredEmailSettings {
  provider: EmailProvider
  host: string
  port: number
  secure: boolean
  user: string
  fromName: string
  /** base64 of safeStorage.encryptString(appPassword); null until first saved. */
  passwordEnc: string | null
}

export interface EmailSettingsInput {
  provider: EmailProvider
  host: string
  port: number
  secure: boolean
  user: string
  fromName?: string
  /** Omit or leave empty to keep the previously-saved password. */
  password?: string
}

/** Safe to send to the client — never includes the password. */
export interface PublicEmailSettings {
  configured: boolean
  provider: EmailProvider
  host: string
  port: number
  secure: boolean
  user: string
  fromName: string
}

export interface TransportConfig {
  host: string
  port: number
  secure: boolean
  user: string
  password: string
  fromName: string
}

export class EmailSettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmailSettingsError'
  }
}

const FILE_NAME = 'email-settings.json'
const settingsPath = () => path.join(userDataDir(), FILE_NAME)

async function readStored(): Promise<StoredEmailSettings | null> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && typeof parsed.host === 'string') {
      return parsed as StoredEmailSettings
    }
    return null
  } catch {
    return null // missing or unreadable → treat as not configured
  }
}

function toPublic(s: StoredEmailSettings): PublicEmailSettings {
  return {
    configured: !!s.passwordEnc,
    provider: s.provider,
    host: s.host,
    port: s.port,
    secure: s.secure,
    user: s.user,
    fromName: s.fromName ?? '',
  }
}

export async function getSettings(): Promise<PublicEmailSettings | null> {
  const s = await readStored()
  return s ? toPublic(s) : null
}

/** saveSettings is read-modify-write; see lib/atomicFile.ts for why it queues. */
const queued = createUpdateQueue()

export function saveSettings(input: EmailSettingsInput): Promise<PublicEmailSettings> {
  return queued(() => saveSettingsNow(input))
}

async function saveSettingsNow(input: EmailSettingsInput): Promise<PublicEmailSettings> {
  const existing = await readStored()
  let passwordEnc = existing?.passwordEnc ?? null

  if (input.password && input.password.length > 0) {
    if (!(await encryptionAvailable())) {
      throw new EmailSettingsError(
        'Secure storage is unavailable on this system, so the email password cannot be saved safely.',
      )
    }
    passwordEnc = await encryptToBase64(input.password)
  }

  const stored: StoredEmailSettings = {
    provider: input.provider,
    host: input.host,
    port: input.port,
    secure: input.secure,
    user: input.user,
    fromName: input.fromName ?? '',
    passwordEnc,
  }

  await fs.mkdir(userDataDir(), { recursive: true })
  // Atomic: a torn file reads back as "not configured" and loses the app password.
  await writeFileAtomic(settingsPath(), JSON.stringify(stored, null, 2))
  return toPublic(stored)
}

/** Decrypts the password for nodemailer. Null when not configured or undecryptable. */
export async function getTransportConfig(): Promise<TransportConfig | null> {
  const s = await readStored()
  if (!s || !s.passwordEnc) return null
  const password = await decryptFromBase64(s.passwordEnc)
  if (password === null) return null
  return {
    host: s.host,
    port: s.port,
    secure: s.secure,
    user: s.user,
    password,
    fromName: s.fromName ?? '',
  }
}
