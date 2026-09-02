/**
 * Auto-update status, published by the Electron main process for the UI to read.
 *
 * electron-updater can only run in the main process, so this module is a mailbox
 * plus an install trigger: main pushes state in via `setUpdateState`, the
 * renderer polls `GET /api/system/update`, and "Restart to update" calls back
 * through the injected installer.
 */

export type UpdateStatus = 'idle' | 'checking' | 'downloading' | 'ready' | 'error'

export interface UpdateState {
  status: UpdateStatus
  version: string | null
  /** Set on 'error'. Recorded for support; the UI stays quiet about failures. */
  message: string | null
}

const IDLE: UpdateState = { status: 'idle', version: null, message: null }

let state: UpdateState = IDLE
let installer: (() => void) | null = null

/** Wired once at startup by the Electron main process (and by tests with fakes). */
export function configureUpdates(opts: { install?: (() => void) | null }): void {
  if ('install' in opts) installer = opts.install ?? null
}

export function setUpdateState(next: { status: UpdateStatus; version?: string | null; message?: string | null }): void {
  state = { version: null, message: null, ...next }
}

export function getUpdateState(): UpdateState {
  return state
}

/**
 * Quit and install a downloaded update. False when nothing is ready or when
 * running outside Electron, which the route turns into a 409 rather than
 * pretending the restart is happening.
 */
export function installUpdate(): boolean {
  if (!installer || state.status !== 'ready') return false
  installer()
  return true
}

/** Test seam — resets the module between cases. */
export function resetUpdateStateForTests(): void {
  state = IDLE
  installer = null
}
