import fs from 'fs'
import path from 'path'
import { userDataDir, decryptFromBase64, encryptionAvailable } from './secureStore.js'
import { log } from '../lib/logger.js'

/**
 * The settings half of a restore.
 *
 * A backup used to be the database and nothing else, while the UI told the coach
 * it held "athletes, programs, payments and settings". Two of those were a lie:
 * the email and Discord configuration live in JSON files beside the database,
 * not inside it, so a coach restoring after a disk failure got their athletes
 * back and silently lost their SMTP setup and their Discord connection.
 *
 * Staged rather than applied immediately for the same reason the database is —
 * see pendingRestore.ts — and kept in its own module so db.ts can stay unaware
 * of it. Unlike the database, though, these are applied AFTER the secure store
 * is wired up, because deciding what to do with the secrets requires being able
 * to attempt a decrypt. See applySettings.
 */

export const PENDING_SETTINGS_DIR = 'restore-pending-settings'

/** The files a backup carries besides the database, and the secret in each. */
export const SETTINGS_FILES = [
  { name: 'email-settings.json', secretKey: 'passwordEnc' },
  { name: 'discord-settings.json', secretKey: 'tokenEnc' },
] as const

export function pendingSettingsDir(dbPath: string): string {
  return path.join(path.dirname(dbPath), PENDING_SETTINGS_DIR)
}

export function hasPendingSettings(dbPath: string): boolean {
  if (!dbPath || dbPath === ':memory:') return false
  return fs.existsSync(pendingSettingsDir(dbPath))
}

/** Stage one settings file for the next launch to apply. */
export function stageSettingsFile(dbPath: string, name: string, contents: Buffer): void {
  const dir = pendingSettingsDir(dbPath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, path.basename(name)), contents)
}

export function clearPendingSettings(dbPath: string): void {
  fs.rmSync(pendingSettingsDir(dbPath), { recursive: true, force: true })
}

export interface SettingsRestoreResult {
  restored: string[]
  /** Files whose secret could not be decrypted here and was dropped. */
  secretsDropped: string[]
}

/**
 * Decide what to do with one file's secret.
 *
 * The credentials are sealed with the OS keychain (DPAPI on Windows), which is
 * bound to the user profile that sealed them. On the machine the backup came
 * from they decrypt fine and there is no reason to make the coach type their app
 * password again. Anywhere else they are undecryptable bytes — and keeping those
 * is worse than dropping them, because the app would go on reporting itself
 * "configured" while every send failed at send time with a confusing error.
 *
 * So: try it. Keep what works, drop what doesn't, and say which.
 */
function resolveSecret(parsed: Record<string, unknown>, secretKey: string): boolean {
  const secret = parsed[secretKey]
  if (typeof secret !== 'string' || secret === '') return false

  // No keychain at all (outside Electron, or encryption unavailable on this box)
  // means the secret cannot be verified, and an unverifiable credential is
  // exactly the silent-failure case above.
  if (!encryptionAvailable() || decryptFromBase64(secret) === null) {
    delete parsed[secretKey]
    return true
  }
  return false
}

/**
 * Apply staged settings files, if any. Returns what happened, or null when
 * there was nothing staged.
 *
 * MUST be called after configureSecureStore — resolveSecret needs the keychain
 * to tell a same-machine restore from a cross-machine one. Called from the
 * Electron main process rather than from initializeDatabase for that reason.
 */
export function applyPendingSettingsRestore(dbPath: string): SettingsRestoreResult | null {
  if (!hasPendingSettings(dbPath)) return null
  const dir = pendingSettingsDir(dbPath)
  const result: SettingsRestoreResult = { restored: [], secretsDropped: [] }

  for (const { name, secretKey } of SETTINGS_FILES) {
    const staged = path.join(dir, name)
    if (!fs.existsSync(staged)) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(staged, 'utf8')) as Record<string, unknown>
      if (resolveSecret(parsed, secretKey)) result.secretsDropped.push(name)
      fs.mkdirSync(userDataDir(), { recursive: true })
      fs.writeFileSync(path.join(userDataDir(), name), JSON.stringify(parsed, null, 2), 'utf8')
      result.restored.push(name)
    } catch (err) {
      // A corrupt settings file must never stop the app from starting; the coach
      // can re-enter the settings, but only if they can open the app to do it.
      log(`Restore: skipped ${name} (${err instanceof Error ? err.message : String(err)})`)
    }
  }

  clearPendingSettings(dbPath)
  if (result.restored.length) {
    log(
      `Restore applied settings: ${result.restored.join(', ')}` +
        (result.secretsDropped.length
          ? ` — credentials dropped (not from this machine): ${result.secretsDropped.join(', ')}`
          : ''),
    )
  }
  return result
}
