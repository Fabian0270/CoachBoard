import fs from 'fs/promises'
import path from 'path'
import {
  userDataDir,
  encryptToBase64,
  decryptFromBase64,
  encryptionAvailable,
} from './secureStore.js'
import type { PublicDiscordSettings } from 'coachboard-shared/discord'

// ---------------------------------------------------------------------------
// Discord bot settings — persisted to a JSON file in userData, mirroring the
// email settings pattern. The bot token is stored as a safeStorage-encrypted
// base64 blob, never plaintext, never in SQLite, never sent to the client.
// ---------------------------------------------------------------------------

interface StoredDiscordSettings {
  /** base64 of safeStorage.encryptString(botToken); null until first saved. */
  tokenEnc: string | null
  applicationId: string | null
  botUserId: string | null
  botUsername: string | null
  autoSyncEnabled: boolean
  autoSyncMinutes: number
  /** Auto-delete synced videos older than this many days; 0 = Never. Default 90. */
  retentionDays: number
  /** Auto-delete DM messages older than this many days; 0 = Never. Default 90. */
  messageRetentionDays: number
  /** Set after a 401 from Discord — the coach must paste a fresh token. */
  tokenInvalid: boolean
}

export class DiscordSettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiscordSettingsError'
  }
}

const FILE_NAME = 'discord-settings.json'
const settingsPath = () => path.join(userDataDir(), FILE_NAME)

/**
 * Bot permissions requested in the invite URL:
 * View Channels (1024) + Send Messages (2048) + Attach Files (32768) +
 * Read Message History (65536). Deliberately minimal — no admin, no moderation.
 *
 * Attach Files was added for Feature 11c's feedback recordings. Note that a bot
 * invited before that keeps the OLD permission bits until the coach re-invites
 * it — Discord does not upgrade an existing install. DMs are unaffected, since
 * a DM channel is not governed by guild permissions, and DMs are how recordings
 * are sent; only attaching a file to a guild channel needs the re-invite.
 */
export const BOT_PERMISSIONS = 101376

export function buildInviteUrl(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${applicationId}&scope=bot&permissions=${BOT_PERMISSIONS}`
}

const DEFAULTS: StoredDiscordSettings = {
  tokenEnc: null,
  applicationId: null,
  botUserId: null,
  botUsername: null,
  autoSyncEnabled: false,
  autoSyncMinutes: 30,
  retentionDays: 90,
  messageRetentionDays: 90,
  tokenInvalid: false,
}

async function readStored(): Promise<StoredDiscordSettings> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      return { ...DEFAULTS, ...(parsed as Partial<StoredDiscordSettings>) }
    }
    return { ...DEFAULTS }
  } catch {
    return { ...DEFAULTS } // missing or unreadable → treat as not configured
  }
}

async function writeStored(s: StoredDiscordSettings): Promise<void> {
  await fs.mkdir(userDataDir(), { recursive: true })
  await fs.writeFile(settingsPath(), JSON.stringify(s, null, 2), 'utf8')
}

function toPublic(s: StoredDiscordSettings): PublicDiscordSettings {
  return {
    configured: !!s.tokenEnc,
    botUsername: s.botUsername,
    applicationId: s.applicationId,
    inviteUrl: s.applicationId ? buildInviteUrl(s.applicationId) : null,
    autoSyncEnabled: s.autoSyncEnabled,
    autoSyncMinutes: s.autoSyncMinutes,
    retentionDays: s.retentionDays,
    messageRetentionDays: s.messageRetentionDays,
    tokenInvalid: s.tokenInvalid,
  }
}

export async function getPublicSettings(): Promise<PublicDiscordSettings> {
  return toPublic(await readStored())
}

/** Saves a validated token + bot identity. Clears any previous tokenInvalid flag. */
export async function saveToken(
  token: string,
  meta: { applicationId: string; botUserId: string; botUsername: string },
): Promise<PublicDiscordSettings> {
  if (!encryptionAvailable()) {
    throw new DiscordSettingsError(
      'Secure storage is unavailable on this system, so the bot token cannot be saved safely.',
    )
  }
  const existing = await readStored()
  const stored: StoredDiscordSettings = {
    ...existing,
    tokenEnc: encryptToBase64(token),
    applicationId: meta.applicationId,
    botUserId: meta.botUserId,
    botUsername: meta.botUsername,
    tokenInvalid: false,
  }
  await writeStored(stored)
  return toPublic(stored)
}

/** Decrypts the bot token for server-side Discord calls. Never routed to the client. */
export async function getToken(): Promise<string | null> {
  const s = await readStored()
  if (!s.tokenEnc) return null
  return decryptFromBase64(s.tokenEnc)
}

export async function getBotUserId(): Promise<string | null> {
  return (await readStored()).botUserId
}

export async function setAutoSync(opts: {
  enabled: boolean
  minutes: number
}): Promise<PublicDiscordSettings> {
  const existing = await readStored()
  const stored: StoredDiscordSettings = {
    ...existing,
    autoSyncEnabled: opts.enabled,
    autoSyncMinutes: opts.minutes,
  }
  await writeStored(stored)
  return toPublic(stored)
}

export async function setRetentionDays(days: number): Promise<PublicDiscordSettings> {
  const existing = await readStored()
  const stored: StoredDiscordSettings = { ...existing, retentionDays: Math.max(0, Math.floor(days)) }
  await writeStored(stored)
  return toPublic(stored)
}

export async function getRetentionDays(): Promise<number> {
  return (await readStored()).retentionDays
}

export async function setMessageRetentionDays(days: number): Promise<PublicDiscordSettings> {
  const existing = await readStored()
  const stored: StoredDiscordSettings = { ...existing, messageRetentionDays: Math.max(0, Math.floor(days)) }
  await writeStored(stored)
  return toPublic(stored)
}

export async function getMessageRetentionDays(): Promise<number> {
  return (await readStored()).messageRetentionDays
}

export async function markTokenInvalid(invalid: boolean): Promise<void> {
  const existing = await readStored()
  if (existing.tokenInvalid === invalid) return
  await writeStored({ ...existing, tokenInvalid: invalid })
}

/** Disconnect: forget the token and all bot identity/prefs. */
export async function clearSettings(): Promise<void> {
  try {
    await fs.unlink(settingsPath())
  } catch {
    /* already gone */
  }
}
