import fs from 'fs'
import os from 'os'
import path from 'path'
import JSZip from 'jszip'
import { openSqlite } from '../sqlite.js'
import { getDatabasePath, getSqlite } from '../db.js'
import {
  clearRestoreFailure,
  pendingRestorePath,
  readRestoreFailure,
  type RestoreFailure,
} from './pendingRestore.js'
import {
  SETTINGS_FILES,
  clearPendingSettings,
  hasPendingSettings,
  stageSettingsFile,
} from './pendingSettingsRestore.js'
import { userDataDir } from './secureStore.js'
import { log } from '../lib/logger.js'
import { writeZip, type ZipEntry } from '../lib/zipWriter.js'
import { BACKUP_PREFIX, BACKUP_SUFFIX, KEEP_BACKUPS, backupFileName } from './backupFiles.js'
import { copyToMirror } from './backupMirrorService.js'

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
    // Read and compressed without holding the main thread: this server runs in
    // Electron's main process, and JSZip used to compress here in JavaScript —
    // a 315 MB database took 10.5 s with freezes of half a second. See zipWriter.
    // The database copy is streamed from disk rather than read whole.
    const entries: ZipEntry[] = [{ name: DB_ENTRY, path: tmp }]

    for (const { name } of SETTINGS_FILES) {
      const src = path.join(userDataDir(), name)
      // Absent is the ordinary case for a coach who never set up email or
      // Discord, so it is not worth a warning.
      if (fs.existsSync(src)) entries.push({ name, data: await fs.promises.readFile(src) })
    }

    entries.push({
      name: 'manifest.json',
      data: Buffer.from(
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
      ),
    })

    // A SQLite file is mostly compressible page padding; 6 is the usual
    // size/time sweet spot and keeps a large database quick to write.
    return await writeZip(entries, 6)
  } finally {
    // Async: deleting a database-sized file synchronously was the single
    // longest freeze left in the export (~0.3 s at 315 MB on Windows).
    await fs.promises.rm(tmp, { force: true }).catch(() => {})
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

/** How many rolling backups there are and how much space they take. */
export function backupStorage(): { files: number; bytes: number } {
  if (!backupsPossible()) return { files: 0, bytes: 0 }
  const files = listBackups()
  let bytes = 0
  for (const f of files) {
    try {
      bytes += fs.statSync(path.join(backupDir(), f)).size
    } catch {
      /* pruned between listing and stat */
    }
  }
  return { files: files.length, bytes }
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
    const dest = path.join(backupDir(), backupFileName())
    await writeBackupTo(dest)
    pruneOldBackups()
    log(`Startup backup written: ${dest}`)
    // Also into the second backup folder, if the coach chose one (N4). Not
    // awaited: a large database going to a slow USB drive must not hold up
    // the app's start. Its outcome is recorded for Settings.
    lastMirrorCopy = copyToMirror(dest)
    return dest
  } catch (err) {
    log(`Startup backup failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

let lastMirrorCopy: Promise<boolean> = Promise.resolve(false)
/** The copy to the second folder that the last backup started. For tests and "Back up now". */
export function mirrorCopyDone(): Promise<boolean> {
  return lastMirrorCopy
}

/** The newest rolling backup on disk, or null. */
export function newestBackupPath(): string | null {
  if (!backupsPossible()) return null
  const files = listBackups()
  return files.length ? path.join(backupDir(), files[files.length - 1]) : null
}

const HOUR_MS = 60 * 60 * 1000

/**
 * A backup once a day while the app stays open (D92), not only at launch: a
 * coach who leaves CoachBoard running all week still gets one a day, locally
 * and in the second folder. Checked every hour; returns a stop function.
 */
export function startDailyBackups(opts: { checkEveryMs?: number; maxAgeMs?: number } = {}): () => void {
  const maxAge = opts.maxAgeMs ?? 24 * HOUR_MS
  let running = false
  const check = async () => {
    if (running) return
    running = true
    try {
      const newest = newestBackupPath()
      const age = newest ? Date.now() - fs.statSync(newest).mtimeMs : Infinity
      if (age >= maxAge) {
        log('Daily backup: the newest is a day old, taking another')
        await runStartupBackup()
      }
    } catch (err) {
      log(`Daily backup check failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void check(), opts.checkEveryMs ?? HOUR_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

export interface BackupInfo {
  databasePath: string
  databaseBytes: number
  backupDir: string
  backupCount: number
  latestBackup: string | null
  restorePending: boolean
  /** The last restore replaced a database that can still be brought back. */
  canUndoRestore: boolean
  /** Set when a restored database could not be used and was rolled back. */
  restoreFailure: RestoreFailure | null
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
    canUndoRestore: backupsPossible() && fs.existsSync(`${dbPath}.replaced`),
    restoreFailure: backupsPossible() ? readRestoreFailure(dbPath) : null,
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
      // The header and table list only prove the file STARTS like a CoachBoard
      // database. Damage in its data pages passed both — measured in the audit,
      // a file with its back 40% overwritten was accepted — and the app then
      // opened fine and failed every list. quick_check reads every page.
      const check = probe.prepare('PRAGMA quick_check').all() as { quick_check: string }[]
      if (check[0]?.quick_check !== 'ok') {
        return 'That backup is damaged — parts of it cannot be read — so it was not used. Try an older backup.'
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
  // A new restore supersedes the note about an earlier one that failed.
  clearRestoreFailure(dbPath)
  log(
    `Restore staged; will be applied on next launch` +
      (staged.length ? ` (with ${staged.join(', ')})` : ' (database only)'),
  )
  return { settings: staged }
}

/**
 * Stage the database the last restore replaced, to come back at next launch.
 *
 * Every restore keeps the outgoing database as `<db>.replaced` and the outgoing
 * settings files as `<name>.replaced`, but there was no way back to them short
 * of renaming files by hand. Undo stages them through the same two-step path a
 * restore uses, so undoing an undo works too.
 *
 * A settings file the coach did not have before the restore stays as restored:
 * there is nothing to put back for it.
 */
export function stageUndoRestore(): StagedRestore {
  if (!backupsPossible()) throw new RestoreError('Restore is not available in this environment.')
  const dbPath = getDatabasePath()
  const previous = `${dbPath}.replaced`
  if (!fs.existsSync(previous)) {
    throw new RestoreError('There is no earlier database to go back to.')
  }
  const buf = fs.readFileSync(previous)
  const reason = validateDatabaseBuffer(buf)
  if (reason) throw new RestoreError(`The earlier database cannot be used: ${reason}`)

  clearPendingSettings(dbPath)
  const staged: string[] = []
  for (const { name } of SETTINGS_FILES) {
    const kept = path.join(userDataDir(), `${name}.replaced`)
    if (!fs.existsSync(kept)) continue
    stageSettingsFile(dbPath, name, fs.readFileSync(kept))
    staged.push(name)
  }
  fs.writeFileSync(pendingRestorePath(dbPath), buf)
  clearRestoreFailure(dbPath)
  log(`Undo of the last restore staged; will be applied on next launch`)
  return { settings: staged }
}

/** Dismiss the Settings notice about a restore that was rolled back. */
export function dismissRestoreFailure(): void {
  if (backupsPossible()) clearRestoreFailure(getDatabasePath())
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
