import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import JSZip from 'jszip'
import { initializeDatabase, getDb, getDatabasePath } from '../db.js'
import { createAthlete } from './athleteService.js'
import {
  RestoreError,
  backupInfo,
  cancelPendingRestore,
  exportToBuffer,
  runStartupBackup,
  stageRestore,
  validateDatabaseBuffer,
  writeBackupTo,
} from './backupService.js'
import { applyPendingRestore, pendingRestorePath } from './pendingRestore.js'
import { applyPendingSettingsRestore, hasPendingSettings } from './pendingSettingsRestore.js'
import { configureSecureStore } from './secureStore.js'

vi.spyOn(console, 'log').mockImplementation(() => {})

let dir = ''
let dbPath = ''

const athleteNames = async () =>
  (await getDb().selectFrom('athletes').select('name').execute()).map((a) => a.name).sort()

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coachboard-backup-'))
  dbPath = path.join(dir, 'coachboard.sqlite')
  // The settings files a backup carries live in userData, not beside the
  // database by accident — point it at the temp dir so export/restore read and
  // write the same place the test does. No safeStorage is injected on purpose:
  // that is the cross-machine case, where a sealed credential cannot be
  // decrypted and must be dropped rather than kept.
  configureSecureStore({ userDataDir: dir })
  await initializeDatabase(dbPath)
})

afterAll(async () => {
  // Windows keeps the file locked until SQLite lets go, so close before deleting.
  try {
    await getDb().destroy()
  } catch {
    /* already closed by a test */
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* a leftover temp dir is not worth failing the suite over */
  }
})

describe('backup export', () => {
  it('exports an archive whose database contains the live data', async () => {
    await createAthlete({ name: 'Exported Athlete' })

    const buf = await exportToBuffer()
    // A zip now, not a bare database — see the format note in backupService.
    expect(buf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))

    const zip = await JSZip.loadAsync(buf)
    const db = await zip.file('coachboard.sqlite')!.async('nodebuffer')
    expect(validateDatabaseBuffer(db)).toBeNull()
  })

  it('carries the settings files that live outside the database', async () => {
    // The whole reason the format changed: these two are not in the database, so
    // a database-only backup silently dropped the coach's email and Discord
    // setup while the UI claimed backups covered "settings".
    fs.writeFileSync(
      path.join(dir, 'email-settings.json'),
      JSON.stringify({ host: 'smtp.gmail.com', port: 465, user: 'c@example.com', passwordEnc: 'SEALED' }),
    )
    fs.writeFileSync(
      path.join(dir, 'discord-settings.json'),
      JSON.stringify({ tokenEnc: 'SEALED', autoSyncMinutes: 30 }),
    )

    const zip = await JSZip.loadAsync(await exportToBuffer())
    expect(zip.file('email-settings.json')).not.toBeNull()
    expect(zip.file('discord-settings.json')).not.toBeNull()

    // Secrets ride along rather than being stripped here: restoring onto the
    // same machine can still decrypt them, and only restore can find that out.
    const email = JSON.parse(await zip.file('email-settings.json')!.async('string'))
    expect(email.passwordEnc).toBe('SEALED')
  })

  it('records what the archive deliberately leaves out', async () => {
    const zip = await JSZip.loadAsync(await exportToBuffer())
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'))
    expect(manifest.format).toBe(1)
    expect(manifest.excludes.join(' ')).toMatch(/media/i)
  })

  it('exports fine for a coach who has no settings files at all', async () => {
    for (const name of ['email-settings.json', 'discord-settings.json']) {
      fs.rmSync(path.join(dir, name), { force: true })
    }
    const zip = await JSZip.loadAsync(await exportToBuffer())
    expect(zip.file('coachboard.sqlite')).not.toBeNull()
    expect(zip.file('email-settings.json')).toBeNull()
  })

  it('reports where the database lives and how big it is', () => {
    const info = backupInfo()
    expect(info.databasePath).toBe(dbPath)
    expect(info.databaseBytes).toBeGreaterThan(0)
    expect(info.restorePending).toBe(false)
  })

  it('writes rolling backups next to the database', async () => {
    const dest = await runStartupBackup()
    expect(dest).not.toBeNull()
    expect(fs.existsSync(dest!)).toBe(true)
    expect(backupInfo().backupCount).toBeGreaterThan(0)
  })
})

describe('backup validation', () => {
  it('rejects an empty file', () => {
    expect(validateDatabaseBuffer(Buffer.alloc(0))).toMatch(/empty/i)
  })

  it('rejects a file that is not a SQLite database', () => {
    expect(validateDatabaseBuffer(Buffer.from('this is a spreadsheet, not a database'))).toMatch(
      /not a SQLite database/i,
    )
  })

  it('rejects a SQLite database that is not a CoachBoard one', async () => {
    const strayPath = path.join(dir, 'stray.sqlite')
    const { openSqlite } = await import('../sqlite.js')
    const stray = openSqlite(strayPath)
    stray.exec('CREATE TABLE unrelated (id TEXT)')
    stray.close()

    const reason = validateDatabaseBuffer(fs.readFileSync(strayPath))
    expect(reason).toMatch(/athletes/)
    expect(reason).toMatch(/not a CoachBoard backup/i)
  })

  it('refuses to stage a rejected file', async () => {
    await expect(stageRestore(Buffer.from('nope'))).rejects.toThrow(RestoreError)
    expect(fs.existsSync(pendingRestorePath(dbPath))).toBe(false)
  })

  it('refuses a zip that is not a CoachBoard backup', async () => {
    const notABackup = new JSZip()
    notABackup.file('holiday.jpg', 'not a database')
    const buf = await notABackup.generateAsync({ type: 'nodebuffer' })

    await expect(stageRestore(buf)).rejects.toThrow(/coachboard.sqlite/i)
    // Nothing may be left staged from a refused archive.
    expect(fs.existsSync(pendingRestorePath(dbPath))).toBe(false)
    expect(hasPendingSettings(dbPath)).toBe(false)
  })
})

describe('restore round-trip', () => {
  it('restores the database as it was when the backup was taken', async () => {
    // Snapshot a known-good state...
    const snapshot = await exportToBuffer()
    const before = await athleteNames()
    expect(before).toContain('Exported Athlete')

    // ...then make a change that the restore should undo.
    await createAthlete({ name: 'Added After Backup' })
    expect(await athleteNames()).toContain('Added After Backup')

    // Staging must not touch the live database — the app is still using it.
    await stageRestore(snapshot)
    expect(fs.existsSync(pendingRestorePath(dbPath))).toBe(true)
    expect(await athleteNames()).toContain('Added After Backup')
    expect(backupInfo().restorePending).toBe(true)

    // The swap happens at the next launch, before anything opens the file.
    await getDb().destroy()
    expect(applyPendingRestore(dbPath)).toBe(true)
    expect(fs.existsSync(`${dbPath}.replaced`)).toBe(true)
    await initializeDatabase(dbPath)

    const after = await athleteNames()
    expect(after).toContain('Exported Athlete')
    expect(after).not.toContain('Added After Backup')
  })

  it('lets a staged restore be cancelled before restarting', async () => {
    await stageRestore(await exportToBuffer())
    expect(cancelPendingRestore()).toBe(true)
    expect(fs.existsSync(pendingRestorePath(dbPath))).toBe(false)
    // Cancelling must take the settings half too, or it would land silently at
    // the next launch after the coach changed their mind.
    expect(hasPendingSettings(dbPath)).toBe(false)
    // Cancelling twice is not an error, just a no-op.
    expect(cancelPendingRestore()).toBe(false)
  })

  it('still restores a bare .sqlite backup taken before the archive format', async () => {
    // Backups a coach already has must keep working. A backup format that
    // invalidates your existing backups is not a backup format.
    const legacy = path.join(dir, 'legacy-backup.sqlite')
    await writeBackupTo(legacy)

    const staged = await stageRestore(fs.readFileSync(legacy))
    expect(staged.settings).toEqual([])
    expect(fs.existsSync(pendingRestorePath(dbPath))).toBe(true)
    cancelPendingRestore()
  })
})

describe('restoring the settings half', () => {
  const emailPath = () => path.join(dir, 'email-settings.json')

  it('stages settings out of the archive and applies them at launch', async () => {
    fs.writeFileSync(
      emailPath(),
      JSON.stringify({ host: 'smtp.gmail.com', port: 465, user: 'c@example.com', passwordEnc: 'SEALED' }),
    )
    const archive = await exportToBuffer()

    // Simulate the coach's machine no longer having the settings at all.
    fs.rmSync(emailPath(), { force: true })

    const staged = await stageRestore(archive)
    expect(staged.settings).toContain('email-settings.json')
    // Staged, not yet applied — the same two-step the database uses.
    expect(fs.existsSync(emailPath())).toBe(false)

    const result = applyPendingSettingsRestore(dbPath)
    expect(result?.restored).toContain('email-settings.json')
    expect(fs.existsSync(emailPath())).toBe(true)

    const restored = JSON.parse(fs.readFileSync(emailPath(), 'utf8'))
    expect(restored.host).toBe('smtp.gmail.com')
    expect(restored.user).toBe('c@example.com')
    cancelPendingRestore()
  })

  it('drops a credential it cannot decrypt here, keeping the rest', async () => {
    // No keychain is wired up in tests, which is exactly the cross-machine case:
    // the sealed bytes cannot be verified, so keeping them would leave the app
    // reporting itself "configured" while every send failed at send time.
    fs.writeFileSync(
      emailPath(),
      JSON.stringify({ host: 'smtp.gmail.com', port: 465, user: 'c@example.com', passwordEnc: 'SEALED' }),
    )
    await stageRestore(await exportToBuffer())
    const result = applyPendingSettingsRestore(dbPath)

    expect(result?.secretsDropped).toContain('email-settings.json')
    const restored = JSON.parse(fs.readFileSync(emailPath(), 'utf8'))
    expect(restored.passwordEnc).toBeUndefined()
    expect(restored.host).toBe('smtp.gmail.com')
    cancelPendingRestore()
  })

  it('has nothing to do when no restore is staged', () => {
    expect(applyPendingSettingsRestore(dbPath)).toBeNull()
  })
})

describe('writeBackupTo', () => {
  it('creates the destination directory if it does not exist', async () => {
    const dest = path.join(dir, 'nested', 'deeper', 'copy.sqlite')
    await writeBackupTo(dest)
    expect(fs.existsSync(dest)).toBe(true)
    expect(validateDatabaseBuffer(fs.readFileSync(dest))).toBeNull()
  })

  it('keeps the database path stable across a reinitialize', () => {
    expect(getDatabasePath()).toBe(dbPath)
  })
})
