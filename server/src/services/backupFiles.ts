// Names of the rolling backup files, shared by the local backups and the
// second backup folder (N4).

/** How many rolling backups to keep, in each folder. */
export const KEEP_BACKUPS = 5

export const BACKUP_PREFIX = 'coachboard-'
export const BACKUP_SUFFIX = '.sqlite'

/** A new backup's file name: the time it was taken, which sorts in order. */
export function backupFileName(at = new Date()): string {
  return `${BACKUP_PREFIX}${at.toISOString().replace(/[:.]/g, '-')}${BACKUP_SUFFIX}`
}

/**
 * Exactly a name CoachBoard gives a backup ("coachboard-2026-11-19T00-14-22-123Z.sqlite").
 * The second folder is the coach's own — OneDrive, a USB drive — so pruning
 * there must never touch a file that only looks similar, such as a copy they
 * named themselves.
 */
export function isBackupFileName(name: string): boolean {
  return /^coachboard-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/.test(name)
}
