import fs from 'fs'
import os from 'os'
import path from 'path'
import JSZip from 'jszip'
import { openSqlite } from '../sqlite.js'
import { getDatabasePath, getSqlite } from '../db.js'
import { pendingRestorePath } from './pendingRestore.js'
import {
  SETTINGS_FILES,
  clearPendingSettings,
  hasPendingSettings,
  stageSettingsFile,
} from './pendingSettingsRestore.js'
import { userDataDir } from './secureStore.js'
import { log } from '../lib/logger.js'

/**
 * Backup and restore of a coach's data.
 *
 * A coach's entire business lives on this machine and there was previously no way
 * to copy it, restore it, or even find it. Copies of the database are taken
 * through SQLite's online backup API rather than `fs.copyFile`, so they are
 * consistent even though the app holds it open.
 *
 * WHAT A BACKUP CONTAINS. Not just the database — that was the bug this format
 * exists to fix. The email and Discord settings live in JSON files beside the
 * database, so a database-only backup restored after a disk failure silently
 * dropped the coach's SMTP setup and their Discord connection while the UI
 * claimed it held "athletes, programs, payments and settings".
 *
 * Media is still deliberately OUT: synced Discord videos and kept analysis clips
 * run to many gigabytes, and quietly turning "Save a copy" into a multi-hour
 * write of a file too big to store anywhere is not a backup, it is a trap. The
 * Settings card says so plainly instead of implying otherwise.
 */

/** How many rolling launch backups to keep. */
const KEEP_BACKUPS = 5

const BACKUP_PREFIX = 'coachboard-'
const BACKUP_SUFFIX = '.sqlite'

/** Name the database takes inside the archive. */
const DB_ENTRY = 'coachboard.sqlite'

/** Bumped only if the archive layout changes in a way a reader must know about. */
const ARCHIVE_FORMAT = 1

/** Local file header magic every zip starts with ("PK\x03\x04"). */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

/** Every SQLite file starts with this header string. */
const SQLITE_MAGIC = 'SQLite format 3'

const isZip = (buf: Buffer): boolean => buf.subarray(0, 4).equals(ZIP_MAGIC)
const isSqlite = (buf: Buffer): boolean =>
  buf.subarray(0, SQLITE_MAGIC.length).toString('utf8') === SQLITE_MAGIC

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

/**
 * A complete backup as a zip, for downloading through the browser.
 *
 * The encrypted credentials ride along rather than being stripped here: they are
 * sealed to the OS keychain, so restoring onto the SAME machine can keep a
 * working app password instead of making the coach type it again. Restore is
 * where that is decided, because only restore can try the decrypt — see
 * pendingSettingsRestore.applyPendingSettingsRestore.
 */
export async function exportToBuffer(): Promise<Buffer> {
  const tmp = path.join(os.tmpdir(), `coachboard-export-${Date.now()}-${process.pid}.sqlite`)
  try {
    await writeBackupTo(tmp)
    const zip = new JSZip()
    zip.file(DB_ENTRY, fs.readFileSync(tmp))

    for (const { name } of SETTINGS_FILES) {
      const src = path.join(userDataDir(), name)
      // Absent is the ordinary case for a coach who never set up email or
      // Discord, so it is not worth a warning.
      if (fs.existsSync(src)) zip.file(name, fs.readFileSync(src))
    }

    zip.file(
      'manifest.json',
      JSON.stringify(
        {
          format: ARCHIVE_FORMAT,
          createdAt: new Date().toISOString(),
          // States what is NOT here, so anyone opening the zip later can tell
          // an intentionally partial backup from a truncated one.
          excludes: ['media (Discord videos, saved analysis clips, recordings)'],
        },
        null,
        2,
      ),
    )

    return await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      // A SQLite file is mostly compressible page padding; 6 is the usual
      // size/time sweet spot and keeps a large database quick to write.
      compressionOptions: { level: 6 },
    })
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
    restorePending:
      backupsPossible() &&
      (fs.existsSync(pendingRestorePath(dbPath)) || hasPendingSettings(dbPath)),
  }
}

/**
 * Check an uploaded file really is a CoachBoard database before we agree to swap
 * it in. Returns a reason string when it isn't, so the coach gets told why rather
 * than discovering it at next launch when the app won't start.
 */
export function validateDatabaseBuffer(buf: Buffer): string | null {
  if (buf.length === 0) return 'The file is empty.'
  if (!isSqlite(buf)) {
    return 'That is not a SQLite database file.'
  }

  const tmp = path.join(os.tmpdir(), `coachboard-verify-${Date.now()}-${process.pid}.sqlite`)
  try {
    fs.writeFileSync(tmp, buf)
    const probe = openSqlite(tmp, { readonly: true });
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

export interface StagedRestore {
  /** Settings files found in the archive and staged alongside the database. */
  settings: string[]
}

/**
 * Pull the database (and any settings files) out of a backup archive.
 *
 * Entries are matched on basename so a zip written by another tool, which may
 * nest everything under a folder, still restores. Anything not recognised is
 * ignored rather than rejected — a future format adding a file must not make
 * this version refuse the whole backup.
 */
async function readArchive(buf: Buffer): Promise<{ db: Buffer; settings: Map<string, Buffer> }> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buf)
  } catch {
    throw new RestoreError('That file is not a readable CoachBoard backup.')
  }

  const wanted = new Set<string>(SETTINGS_FILES.map((f) => f.name))
  const settings = new Map<string, Buffer>()
  let db: Buffer | null = null

  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue
    const base = path.posix.basename(entry.name)
    if (base === DB_ENTRY) db = await entry.async('nodebuffer')
    else if (wanted.has(base)) settings.set(base, await entry.async('nodebuffer'))
  }

  if (!db) {
    throw new RestoreError(
      `That archive has no ${DB_ENTRY} in it, so it is not a CoachBoard backup.`,
    )
  }
  return { db, settings }
}

/**
 * Stage a restore for the next launch. Deliberately does not touch the live
 * database — see the note in pendingRestore.ts.
 *
 * Accepts BOTH shapes: the current zip archive, and a bare .sqlite from before
 * the archive existed. Backups a coach already took have to keep working — a
 * backup format that invalidates the backups you have is not a backup format.
 */
export async function stageRestore(buf: Buffer): Promise<StagedRestore> {
  if (!backupsPossible()) throw new RestoreError('Restore is not available in this environment.')
  if (buf.length === 0) throw new RestoreError('The file is empty.')

  const dbPath = getDatabasePath()
  let database = buf
  const staged: string[] = []

  if (isZip(buf)) {
    const archive = await readArchive(buf)
    database = archive.db
    // Validate the database BEFORE writing anything, so a bad archive leaves no
    // half-staged restore behind.
    const reason = validateDatabaseBuffer(database)
    if (reason) throw new RestoreError(reason)

    clearPendingSettings(dbPath)
    for (const [name, contents] of archive.settings) {
      stageSettingsFile(dbPath, name, contents)
      staged.push(name)
    }
  } else if (isSqlite(buf)) {
    const reason = validateDatabaseBuffer(database)
    if (reason) throw new RestoreError(reason)
    // A pre-archive backup carries no settings. Clear any staged from an earlier
    // attempt so this restore is exactly what the coach just chose.
    clearPendingSettings(dbPath)
  } else {
    throw new RestoreError('That is not a CoachBoard backup file.')
  }

  fs.writeFileSync(pendingRestorePath(dbPath), database)
  log(
    `Restore staged; will be applied on next launch` +
      (staged.length ? ` (with ${staged.join(', ')})` : ' (database only)'),
  )
  return { settings: staged }
}

/** Let the coach change their mind before restarting. */
export function cancelPendingRestore(): boolean {
  if (!backupsPossible()) return false
  const dbPath = getDatabasePath()
  const pending = pendingRestorePath(dbPath)
  const had = fs.existsSync(pending) || hasPendingSettings(dbPath)
  if (!had) return false
  fs.rmSync(pending, { force: true })
  // Staged settings must go too, or cancelling the database half would leave the
  // settings half to land silently at the next launch.
  clearPendingSettings(dbPath)
  return true
}
