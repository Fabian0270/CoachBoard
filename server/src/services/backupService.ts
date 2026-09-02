import fs from 'fs'
import os from 'os'
import path from 'path'
import BetterSqlite3 from 'better-sqlite3'
import { getDatabasePath, getSqlite } from '../db.js'
import { pendingRestorePath } from './pendingRestore.js'
import { log } from '../lib/logger.js'

/**
 * Backup and restore of the SQLite database.
 *
 * A coach's entire business lives in one file and there was previously no way to
 * copy it, restore it, or even find it. Copies are taken through SQLite's online
 * backup API rather than `fs.copyFile`, so they are consistent even though the
 * app holds the database open.
 */

/** How many rolling launch backups to keep. */
const KEEP_BACKUPS = 5

const BACKUP_PREFIX = 'coachboard-'
const BACKUP_SUFFIX = '.sqlite'

export function backupDir(): string {
  return path.join(path.dirname(getDatabasePath()), 'backups')
}

/** True when there is a real file to back up (i.e. not the in-memory test DB). */
function backupsPossible(): boolean {
  const dbPath = getDatabasePath()
  return !!dbPath && dbPath !== ':memory:'
}

/** Write a consistent copy of the live database to `dest`. */
export async function writeBackupTo(dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  await getSqlite().backup(dest)
}

/** The whole database as bytes, for downloading through the browser. */
export async function exportToBuffer(): Promise<Buffer> {
  const tmp = path.join(os.tmpdir(), `coachboard-export-${Date.now()}-${process.pid}.sqlite`)
  try {
    await writeBackupTo(tmp)
    return fs.readFileSync(tmp)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

function listBackups(): string[] {
  const dir = backupDir()
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith(BACKUP_SUFFIX))
    .sort() // timestamped names sort chronologically
}

function pruneOldBackups(): void {
  const files = listBackups()
  const excess = files.length - KEEP_BACKUPS
  for (const f of files.slice(0, Math.max(0, excess))) {
    fs.rmSync(path.join(backupDir(), f), { force: true })
  }
}

/**
 * Rolling backup taken at launch. Best-effort: a failure here is logged but must
 * never stop the app from starting.
 */
export async function runStartupBackup(): Promise<string | null> {
  if (!backupsPossible()) return null
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = path.join(backupDir(), `${BACKUP_PREFIX}${stamp}${BACKUP_SUFFIX}`)
    await writeBackupTo(dest)
    pruneOldBackups()
    log(`Startup backup written: ${dest}`)
    return dest
  } catch (err) {
    log(`Startup backup failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

export interface BackupInfo {
  databasePath: string
  databaseBytes: number
  backupDir: string
  backupCount: number
  latestBackup: string | null
  restorePending: boolean
}

export function backupInfo(): BackupInfo {
  const dbPath = getDatabasePath()
  const files = backupsPossible() ? listBackups() : []
  let databaseBytes = 0
  try {
    databaseBytes = fs.statSync(dbPath).size
  } catch {
    /* :memory: or not yet written */
  }
  return {
    databasePath: dbPath,
    databaseBytes,
    backupDir: backupsPossible() ? backupDir() : '',
    backupCount: files.length,
    latestBackup: files.length ? files[files.length - 1] : null,
    restorePending: backupsPossible() && fs.existsSync(pendingRestorePath(dbPath)),
  }
}

/**
 * Check an uploaded file really is a CoachBoard database before we agree to swap
 * it in. Returns a reason string when it isn't, so the coach gets told why rather
 * than discovering it at next launch when the app won't start.
 */
export function validateDatabaseBuffer(buf: Buffer): string | null {
  if (buf.length === 0) return 'The file is empty.'
  // Every SQLite file starts with this header string.
  if (buf.subarray(0, 15).toString('utf8') !== 'SQLite format 3') {
    return 'That is not a SQLite database file.'
  }

  const tmp = path.join(os.tmpdir(), `coachboard-verify-${Date.now()}-${process.pid}.sqlite`)
  try {
    fs.writeFileSync(tmp, buf)
    const probe = new BetterSqlite3(tmp, { readonly: true });
    try {
      const rows = probe
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
      const names = new Set(rows.map((r) => r.name))
      for (const required of ['athletes', 'programs', 'workouts', 'exercises']) {
        if (!names.has(required)) {
          return `That database is missing the "${required}" table, so it is not a CoachBoard backup.`
        }
      }
    } finally {
      probe.close()
    }
  } catch (err) {
    return `The file could not be opened as a database (${err instanceof Error ? err.message : String(err)}).`
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  return null
}

export class RestoreError extends Error {}

/**
 * Stage a restore for the next launch. Deliberately does not touch the live
 * database — see the note in pendingRestore.ts.
 */
export function stageRestore(buf: Buffer): void {
  if (!backupsPossible()) throw new RestoreError('Restore is not available in this environment.')
  const reason = validateDatabaseBuffer(buf)
  if (reason) throw new RestoreError(reason)
  fs.writeFileSync(pendingRestorePath(getDatabasePath()), buf)
  log('Database restore staged; will be applied on next launch')
}

/** Let the coach change their mind before restarting. */
export function cancelPendingRestore(): boolean {
  if (!backupsPossible()) return false
  const pending = pendingRestorePath(getDatabasePath())
  if (!fs.existsSync(pending)) return false
  fs.rmSync(pending, { force: true })
  return true
}
