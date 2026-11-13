import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initializeDatabase, getDb } from '../db.js'
import { createAthlete } from './athleteService.js'
import {
  RestoreError,
  backupInfo,
  exportToBuffer,
  stageRestore,
  stageUndoRestore,
  validateDatabaseBuffer,
  writeBackupTo,
} from './backupService.js'
import { pendingRestorePath, readRestoreFailure } from './pendingRestore.js'
import {
  applyPendingSettingsRestore,
  hasPendingSettings,
  stageSettingsFile,
} from './pendingSettingsRestore.js'
import { configureSecureStore } from './secureStore.js'

// A restore swaps the coach's whole database. These are the ways the audit
// found it could go wrong, each of which used to end in an app that would not
// start or that failed every list, with the good database sitting unreachable
// beside it as `.replaced`.

vi.spyOn(console, 'log').mockImplementation(() => {})

let dir = ''
let dbPath = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-restore-'))
  dbPath = path.join(dir, 'coachboard.sqlite')
  configureSecureStore({ userDataDir: dir })
})

afterEach(async () => {
  try {
    await getDb().destroy()
  } catch {
    /* closed by the test */
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

const names = async () =>
  (await getDb().selectFrom('athletes').select('name').execute()).map((a) => a.name).sort()

/** A real CoachBoard database big enough that damage lands in its data pages. */
async function buildBackup(): Promise<Buffer> {
  await initializeDatabase(dbPath)
  const now = new Date().toISOString()
  // One transaction, batched: 1,500 separate inserts took over 7 s under the
  // parallel suite and timed out.
  await getDb().transaction().execute(async (trx) => {
    for (let start = 0; start < 1500; start += 100) {
      await trx
        .insertInto('athletes')
        .values(
          Array.from({ length: 100 }, (_, k) => ({
            id: `backup-${start + k}`,
            name: `Backup Athlete ${start + k}`,
            email: null,
            sport: null,
            weight_class: null,
            height_cm: null,
            date_of_birth: null,
            notes: 'n'.repeat(400),
            archived: 0,
            created_at: now,
            updated_at: now,
          })),
        )
        .execute()
    }
  })
  const file = path.join(dir, 'source.sqlite')
  await writeBackupTo(file)
  await getDb().destroy()
  fs.rmSync(dbPath, { force: true })
  return fs.readFileSync(file)
}

/** Overwrites the back 40% of the file: the header and schema survive, the data does not. */
function damagePages(buf: Buffer): Buffer {
  const out = Buffer.from(buf)
  for (let i = Math.floor(out.length * 0.6); i < out.length; i++) out[i] = (i * 31) & 0xff
  return out
}

/** The coach's live database, holding one athlete. */
async function liveDatabase(name = 'Current Athlete') {
  await initializeDatabase(dbPath)
  await createAthlete({ name })
  await getDb().destroy()
}

describe('staging', () => {
  it('refuses a backup whose data pages are damaged', async () => {
    const damaged = damagePages(await buildBackup())
    // Passed before: the header and table list are intact.
    expect(validateDatabaseBuffer(damaged)).toMatch(/damaged/i)
  })

  it('still accepts an intact backup', async () => {
    expect(validateDatabaseBuffer(await buildBackup())).toBeNull()
  })
})

describe('a restored database that cannot be used at launch', () => {
  it('puts the previous database back when the restored one is damaged', async () => {
    const damaged = damagePages(await buildBackup())
    await liveDatabase()
    // Written straight to the pending path, as an older version that skipped
    // the integrity check would have staged it.
    fs.writeFileSync(pendingRestorePath(dbPath), damaged)
    stageSettingsFile(dbPath, 'email-settings.json', Buffer.from('{"host":"x"}'))

    await initializeDatabase(dbPath)

    expect(await names()).toEqual(['Current Athlete'])
    expect(fs.existsSync(`${dbPath}.failed-restore`)).toBe(true)
    expect(readRestoreFailure(dbPath)).toMatchObject({ previousKept: true })
    // Half a restore is not what the coach asked for.
    expect(hasPendingSettings(dbPath)).toBe(false)
    expect(backupInfo().restoreFailure?.message).toMatch(/damaged/)
  })

  it('puts the previous database back when the restored one will not even open', async () => {
    const truncated = (await buildBackup()).subarray(0, 50_000)
    await liveDatabase()
    fs.writeFileSync(pendingRestorePath(dbPath), truncated)

    await initializeDatabase(dbPath)

    expect(await names()).toEqual(['Current Athlete'])
    expect(readRestoreFailure(dbPath)?.previousKept).toBe(true)
  })

  it('starts empty, rather than not at all, on a fresh install', async () => {
    const damaged = damagePages(await buildBackup())
    fs.writeFileSync(pendingRestorePath(dbPath), damaged)

    await initializeDatabase(dbPath)

    expect(await names()).toEqual([])
    expect(readRestoreFailure(dbPath)?.previousKept).toBe(false)
    expect(fs.existsSync(`${dbPath}.failed-restore`)).toBe(true)
  })
})

describe('undo last restore', () => {
  const emailPath = () => path.join(dir, 'email-settings.json')
  const emailUser = () => JSON.parse(fs.readFileSync(emailPath(), 'utf8')).user

  it('brings back the database AND the settings the restore replaced', async () => {
    await initializeDatabase(dbPath)
    await createAthlete({ name: 'In The Backup' })
    fs.writeFileSync(emailPath(), JSON.stringify({ host: 'smtp', port: 465, user: 'backup@example.com' }))
    const snapshot = await exportToBuffer()

    // Life goes on after the backup...
    await createAthlete({ name: 'Added Later' })
    fs.writeFileSync(emailPath(), JSON.stringify({ host: 'smtp', port: 465, user: 'later@example.com' }))

    // ...then the coach restores the old backup, and regrets it.
    await stageRestore(snapshot)
    await getDb().destroy()
    await initializeDatabase(dbPath)
    await applyPendingSettingsRestore(dbPath)
    expect(await names()).toEqual(['In The Backup'])
    expect(emailUser()).toBe('backup@example.com')
    expect(backupInfo().canUndoRestore).toBe(true)

    const staged = stageUndoRestore()
    expect(staged.settings).toEqual(['email-settings.json'])
    await getDb().destroy()
    await initializeDatabase(dbPath)
    await applyPendingSettingsRestore(dbPath)

    expect(await names()).toEqual(['Added Later', 'In The Backup'])
    expect(emailUser()).toBe('later@example.com')
  })

  it('says so when there is nothing to go back to', async () => {
    await initializeDatabase(dbPath)
    expect(backupInfo().canUndoRestore).toBe(false)
    expect(() => stageUndoRestore()).toThrow(RestoreError)
  })
})
