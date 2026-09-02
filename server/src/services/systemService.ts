import path from 'path'
import { userDataDir } from './secureStore.js'

// ---------------------------------------------------------------------------
// Shell/OS seam. Same injection pattern as secureStore: the Express server runs
// inside the Electron main process, but importing `electron` from the server
// would break the plain-Node test runner. So the main process hands over the few
// shell capabilities the UI needs, and tests inject fakes the same way.
// ---------------------------------------------------------------------------

export interface ShellLike {
  openPath(target: string): Promise<string>
  showItemInFolder(target: string): void
}

let injectedShell: ShellLike | null = null

/** Wired once at startup by the Electron main process (and by tests with fakes). */
export function configureSystem(opts: { shell?: ShellLike | null }): void {
  if ('shell' in opts) injectedShell = opts.shell ?? null
}

/**
 * Everything the app owns lives in one folder: the SQLite database, the log, the
 * synced Discord media, and the encrypted email/Discord settings. Note the folder
 * is named `coachboard-electron` (from electron/package.json "name"), not
 * `CoachBoard` — there is no productName set.
 */
export function dataDir(): string {
  return userDataDir()
}

export function logFilePath(): string {
  return path.join(userDataDir(), 'coachboard.log')
}

export function databasePath(): string {
  return path.join(userDataDir(), 'coachboard.sqlite')
}

/** False when running outside Electron (tests, dev server), so the UI can hide the action. */
export function canReveal(): boolean {
  return injectedShell !== null
}

/**
 * Open the data folder in the OS file manager, optionally highlighting the log.
 *
 * Deliberately takes a named target rather than a path: accepting an arbitrary
 * path from the renderer would hand the UI a general "open anything on this
 * machine" primitive.
 */
export async function reveal(target: 'data' | 'logs'): Promise<boolean> {
  if (!injectedShell) return false
  if (target === 'logs') {
    // Highlights the log file inside the folder rather than just opening it.
    injectedShell.showItemInFolder(logFilePath())
    return true
  }
  await injectedShell.openPath(dataDir())
  return true
}
