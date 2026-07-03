import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { configureSecureStore, type SafeStorageLike } from './secureStore.js'
import {
  getPublicSettings,
  saveToken,
  getToken,
  setAutoSync,
  markTokenInvalid,
  clearSettings,
  buildInviteUrl,
  DiscordSettingsError,
} from './discordSettingsService.js'

const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
}

const TOKEN = 'discord-bot-token-1234567890'
const META = { applicationId: 'app1', botUserId: 'bot1', botUsername: 'coachbot' }

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-discord-'))
  configureSecureStore({ safeStorage: fakeSafeStorage, userDataDir: tmpDir })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('discordSettingsService', () => {
  it('reports unconfigured defaults before anything is saved', async () => {
    const pub = await getPublicSettings()
    expect(pub.configured).toBe(false)
    expect(pub.inviteUrl).toBeNull()
    expect(pub.autoSyncEnabled).toBe(false)
    expect(await getToken()).toBeNull()
  })

  it('saves the token encrypted and never exposes it publicly', async () => {
    const pub = await saveToken(TOKEN, META)
    expect(pub.configured).toBe(true)
    expect(pub.botUsername).toBe('coachbot')
    expect(JSON.stringify(pub)).not.toContain(TOKEN)

    const raw = fs.readFileSync(path.join(tmpDir, 'discord-settings.json'), 'utf8')
    expect(raw).not.toContain(TOKEN)
    expect(raw).toContain('tokenEnc')

    expect(await getToken()).toBe(TOKEN)
  })

  it('builds the invite URL with the minimal two-way permission set', async () => {
    expect(buildInviteUrl('app1')).toBe(
      'https://discord.com/oauth2/authorize?client_id=app1&scope=bot&permissions=68608',
    )
    const pub = await saveToken(TOKEN, META)
    expect(pub.inviteUrl).toContain('client_id=app1')
  })

  it('tokenInvalid survives restarts and is cleared by a fresh token save', async () => {
    await saveToken(TOKEN, META)
    await markTokenInvalid(true)
    expect((await getPublicSettings()).tokenInvalid).toBe(true)

    await saveToken(`${TOKEN}-new`, META)
    expect((await getPublicSettings()).tokenInvalid).toBe(false)
  })

  it('persists auto-sync preferences', async () => {
    await saveToken(TOKEN, META)
    const pub = await setAutoSync({ enabled: true, minutes: 15 })
    expect(pub.autoSyncEnabled).toBe(true)
    expect(pub.autoSyncMinutes).toBe(15)
  })

  it('refuses to save when secure storage is unavailable', async () => {
    configureSecureStore({
      safeStorage: { ...fakeSafeStorage, isEncryptionAvailable: () => false },
      userDataDir: tmpDir,
    })
    await expect(saveToken(TOKEN, META)).rejects.toBeInstanceOf(DiscordSettingsError)
  })

  it('clearSettings forgets everything', async () => {
    await saveToken(TOKEN, META)
    await clearSettings()
    expect((await getPublicSettings()).configured).toBe(false)
    expect(await getToken()).toBeNull()
  })
})
