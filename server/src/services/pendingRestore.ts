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
  for (const suffix of ['-wal', '-shm', '-journal']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true })
  }
  return true
}
