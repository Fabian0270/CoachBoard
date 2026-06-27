import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { configureSecureStore, type SafeStorageLike } from './secureStore.js'
import {
  getSettings, saveSettings, getTransportConfig, EmailSettingsError,
} from './emailSettingsService.js'

// Reversible stand-in for Electron safeStorage so the round-trip is testable
// off-Electron. Prefixes the plaintext so we can prove decrypt is actually run.
const fakeSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`enc:${s}`, 'utf8'),
  decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
}

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-email-'))
  configureSecureStore({ safeStorage: fakeSafeStorage, userDataDir: tmpDir })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const baseInput = {
  provider: 'gmail' as const,
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  user: 'coach@gmail.com',
  fromName: 'Coach',
  password: 'app-pw-1234',
}

describe('emailSettingsService', () => {
  it('returns null before anything is saved', async () => {
    expect(await getSettings()).toBeNull()
    expect(await getTransportConfig()).toBeNull()
  })

  it('saves settings, reports configured, and never leaks the password', async () => {
    const pub = await saveSettings(baseInput)
    expect(pub.configured).toBe(true)
    expect(pub.user).toBe('coach@gmail.com')
    expect(Object.keys(pub)).not.toContain('password')
    expect(JSON.stringify(pub)).not.toContain('app-pw-1234')

    const again = await getSettings()
    expect(again?.configured).toBe(true)
    expect(Object.keys(again ?? {})).not.toContain('password')
  })

  it('persists the password encrypted on disk (not plaintext)', async () => {
    await saveSettings(baseInput)
    const raw = fs.readFileSync(path.join(tmpDir, 'email-settings.json'), 'utf8')
    expect(raw).not.toContain('app-pw-1234')
    expect(raw).toContain('passwordEnc')
  })

  it('decrypts the password for the transport config', async () => {
    await saveSettings(baseInput)
    const cfg = await getTransportConfig()
    expect(cfg?.password).toBe('app-pw-1234')
    expect(cfg?.host).toBe('smtp.gmail.com')
  })

  it('keeps the existing password when saved again without one', async () => {
    await saveSettings(baseInput)
    await saveSettings({ ...baseInput, password: undefined, fromName: 'New Name' })
    const cfg = await getTransportConfig()
    expect(cfg?.password).toBe('app-pw-1234')
    expect(cfg?.fromName).toBe('New Name')
  })

  it('refuses to save a password when secure storage is unavailable', async () => {
    configureSecureStore({
      safeStorage: { ...fakeSafeStorage, isEncryptionAvailable: () => false },
      userDataDir: tmpDir,
    })
    await expect(saveSettings(baseInput)).rejects.toBeInstanceOf(EmailSettingsError)
  })
})
