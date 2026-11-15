import fs from 'fs'
import path from 'path'

/**
 * A restore cannot be applied while the app is running: SQLite holds the database
 * file open for the whole session. So restoring is a two-step operation — the
 * uploaded file is staged next to the live database, and swapped in at the very
 * start of the next launch, before anything opens it.
 *
 * Lives in its own module so `db.ts` can call it without importing the backup
 * service, which imports `db.ts` in turn.
 */

export const PENDING_NAME = 'restore-pending.sqlite'

export function pendingRestorePath(dbPath: string): string {
  return path.join(path.dirname(dbPath), PENDING_NAME)
}

export function hasPendingRestore(dbPath: string): boolean {
  if (!dbPath || dbPath === ':memory:') return false
  return fs.existsSync(pendingRestorePath(dbPath))
}

/**
 * Swap a staged restore into place. Returns whether one was applied.
 *
 * The outgoing database is kept as `<db>.replaced` rather than deleted, so a
 * coach who restores the wrong file has not destroyed the current one.
 */
export function applyPendingRestore(dbPath: string): boolean {
  if (!hasPendingRestore(dbPath)) return false
  const pending = pendingRestorePath(dbPath)

  if (fs.existsSync(dbPath)) {
    fs.rmSync(`${dbPath}.replaced`, { force: true })
    fs.renameSync(dbPath, `${dbPath}.replaced`)
  }
  fs.renameSync(pending, dbPath)

  // Any journal sidecars belong to the database we just moved aside; leaving them
  // would have SQLite try to replay them against the incoming file.
  removeSidecars(dbPath)
  return true
}

function removeSidecars(dbPath: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true })
  }
}

// ---------------------------------------------------------------------------
// When the restored file turns out to be unusable.
//
// Staging checks a backup's integrity, but a restore staged by an older version
// skipped that check, and a disk can fail between staging and the next launch.
// Before this, the outcome was "CoachBoard failed to start" — or, for a file
// whose damage was in its data pages, an app that opened and then failed every
// list. The coach's previous database was sitting right beside it as
// `.replaced`, with no way to get it back short of renaming files by hand.
// ---------------------------------------------------------------------------

/** Note left for the Settings screen, so a rolled-back restore is not silent. */
export const RESTORE_FAILED_NAME = 'restore-failed.json'

export function restoreFailedPath(dbPath: string): string {
  return path.join(path.dirname(dbPath), RESTORE_FAILED_NAME)
}

export interface RestoreFailure {
  at: string
  message: string
  /** False on a fresh install, where there was nothing to go back to. */
  previousKept: boolean
}

export function readRestoreFailure(dbPath: string): RestoreFailure | null {
  if (!dbPath || dbPath === ':memory:') return null
  try {
    return JSON.parse(fs.readFileSync(restoreFailedPath(dbPath), 'utf8')) as RestoreFailure
  } catch {
    return null
  }
}

export function clearRestoreFailure(dbPath: string): void {
  if (!dbPath || dbPath === ':memory:') return
  fs.rmSync(restoreFailedPath(dbPath), { force: true })
}

/**
 * Puts the previous database back after a restored one failed to open.
 *
 * The bad file is kept as `.failed-restore` rather than deleted — it is still
 * the coach's data, and someone may be able to recover it. On a fresh install
 * there is no previous database, so the app starts empty instead of not at all.
 * The caller must have closed its handle on `dbPath` first.
 */
export function rollBackFailedRestore(dbPath: string, reason: unknown): RestoreFailure {
  const replaced = `${dbPath}.replaced`
  const failed = `${dbPath}.failed-restore`
  fs.rmSync(failed, { force: true })
  if (fs.existsSync(dbPath)) fs.renameSync(dbPath, failed)
  removeSidecars(dbPath)

  const previousKept = fs.existsSync(replaced)
  if (previousKept) fs.renameSync(replaced, dbPath)

  const failure: RestoreFailure = {
    at: new Date().toISOString(),
    message: reason instanceof Error ? reason.message : String(reason),
    previousKept,
  }
  fs.writeFileSync(restoreFailedPath(dbPath), JSON.stringify(failure, null, 2))
  return failure
}
