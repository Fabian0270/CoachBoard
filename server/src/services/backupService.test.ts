import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
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

vi.spyOn(console, 'log').mockImplementation(() => {})

let dir = ''
let dbPath = ''

const athleteNames = async () =>
  (await getDb().selectFrom('athletes').select('name').execute()).map((a) => a.name).sort()

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coachboard-backup-'))
  dbPath = path.join(dir, 'coachboard.sqlite')
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
  it('exports a real SQLite database containing the live data', async () => {
    await createAthlete({ name: 'Exported Athlete' })

    const buf = await exportToBuffer()
    expect(buf.subarray(0, 15).toString('utf8')).toBe('SQLite format 3')
    expect(validateDatabaseBuffer(buf)).toBeNull()
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

  it('refuses to stage a rejected file', () => {
    expect(() => stageRestore(Buffer.from('nope'))).toThrow(RestoreError)
    expect(fs.existsSync(pendingRestorePath(dbPath))).toBe(false)
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
    stageRestore(snapshot)
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
    stageRestore(await exportToBuffer())
    expect(cancelPendingRestore()).toBe(true)
    expect(fs.existsSync(pendingRestorePath(dbPath))).toBe(false)
    // Cancelling twice is not an error, just a no-op.
    expect(cancelPendingRestore()).toBe(false)
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
