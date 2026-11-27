import fs from 'fs'
import path from 'path'
import { getDatabasePath } from '../db.js'
import { log } from '../lib/logger.js'
import { KEEP_BACKUPS, isBackupFileName } from './backupFiles.js'

// ---------------------------------------------------------------------------
// The second backup folder (N4, D91–D94).
//
// Off until the coach picks a folder in Settings. Then every backup is also
// copied there — a folder OneDrive or Dropbox syncs, or a USB drive — so the
// data survives the loss of this computer. CoachBoard never uploads anything
// itself; whatever syncs that folder does. The folder keeps the 5 newest, like
// the local one.
//
// The choice is kept in backup-mirror.json beside the database, not in the
// database: a backup restored onto a new computer must not start copying to a
// path from the old one. The same file holds when it last worked and why it
// last failed, for Settings and for the one-time failure message (D93).
// ---------------------------------------------------------------------------

export interface MirrorStatus {
  dir: string | null
  lastCopiedAt: string | null
  lastCopiedFile: string | null
  /** Why the last copy failed; cleared by the next one that works. */
  error: string | null
  /** When copying started failing (the first failure since the last success). */
  failingSince: string | null
  /** A folder can be chosen here: only in the app, which has the folder dialog. */
  canPick: boolean
}

type State = Omit<MirrorStatus, 'canPick'>
const EMPTY: State = { dir: null, lastCopiedAt: null, lastCopiedFile: null, error: null, failingSince: null }

export class MirrorError extends Error {}

type FolderPicker = () => Promise<string | null>
let picker: FolderPicker | null = null

/** Wired by the Electron main process: the system's "choose a folder" dialog. */
export function configureBackupMirror(opts: { pickFolder?: FolderPicker | null }): void {
  if ('pickFolder' in opts) picker = opts.pickFolder ?? null
}

/** The folder the database lives in (the app's data folder). */
function dataFolder(): string | null {
  const db = getDatabasePath()
  return db && db !== ':memory:' ? path.dirname(db) : null
}

function stateFile(): string | null {
  const dir = dataFolder()
  return dir ? path.join(dir, 'backup-mirror.json') : null
}

function readState(): State {
  const file = stateFile()
  if (!file) return { ...EMPTY }
  try {
    return { ...EMPTY, ...(JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<State>) }
  } catch {
    return { ...EMPTY }
  }
}

function writeState(state: State): void {
  const file = stateFile()
  if (!file) return
  try {
    fs.writeFileSync(file, JSON.stringify(state, null, 2))
  } catch (err) {
    log(`Second backup folder: could not save its settings: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export function mirrorStatus(): MirrorStatus {
  return { ...readState(), canPick: picker !== null }
}

const isInside = (child: string, parent: string): boolean => {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** What went wrong, in words a coach can act on. */
function explain(err: unknown, dir: string): string {
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT') return `The folder ${dir} can't be found. Is the drive plugged in, or was the folder moved?`
  if (code === 'EACCES' || code === 'EPERM') return `CoachBoard isn't allowed to save files in ${dir}.`
  if (code === 'ENOSPC') return `The drive with ${dir} is full.`
  if (err instanceof MirrorError) return err.message
  return err instanceof Error ? err.message : String(err)
}

/** Keep the newest KEEP_BACKUPS of CoachBoard's own backup files there; leave anything else alone. */
function prune(dir: string): void {
  const ours = fs.readdirSync(dir).filter(isBackupFileName).sort()
  for (const f of ours.slice(0, Math.max(0, ours.length - KEEP_BACKUPS))) {
    try { fs.rmSync(path.join(dir, f), { force: true }) } catch { /* in use by the sync app: next time */ }
  }
}

/**
 * Copy one backup file to the second folder, if one is set. Never throws: a
 * failure is recorded for Settings and the message, and the local backup it
 * came from is untouched.
 */
export async function copyToMirror(src: string): Promise<boolean> {
  const state = readState()
  const dir = state.dir
  if (!dir) return false
  const name = path.basename(src)
  // Written under another name first: a sync app must never pick up half a file.
  const partial = path.join(dir, `${name}.partial`)
  try {
    if (!fs.statSync(dir).isDirectory()) throw new MirrorError(`${dir} is not a folder.`)
    await fs.promises.copyFile(src, partial)
    await fs.promises.rename(partial, path.join(dir, name))
    prune(dir)
    writeState({ ...state, lastCopiedAt: new Date().toISOString(), lastCopiedFile: name, error: null, failingSince: null })
    log(`Backup copied to the second folder: ${path.join(dir, name)}`)
    return true
  } catch (err) {
    await fs.promises.rm(partial, { force: true }).catch(() => {})
    const error = explain(err, dir)
    writeState({ ...state, error, failingSince: state.failingSince ?? new Date().toISOString() })
    log(`Backup NOT copied to the second folder: ${error}`)
    return false
  }
}

/**
 * Start copying to `dir`. Checked first: it must exist, be outside the app's
 * own data folder (a copy beside the original protects nothing), and take a
 * file. Then the newest backup is copied straight away, so it is visibly
 * working without waiting for the next launch.
 */
export async function setMirrorDir(dir: string, newestBackup: string | null): Promise<MirrorStatus> {
  if (!path.isAbsolute(dir)) throw new MirrorError('Choose a folder on this computer or a drive attached to it.')
  const target = path.resolve(dir)
  let isDir = false
  try { isDir = fs.statSync(target).isDirectory() } catch { /* missing */ }
  if (!isDir) throw new MirrorError(`The folder ${target} can't be found.`)
  const data = dataFolder()
  if (data && (isInside(target, data) || isInside(data, target))) {
    throw new MirrorError("Choose a folder outside CoachBoard's own data folder. A copy next to the original doesn't protect it.")
  }
  const probe = path.join(target, `.coachboard-write-test-${process.pid}`)
  try {
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
  } catch {
    throw new MirrorError(`CoachBoard can't save files in ${target}.`)
  }
  writeState({ ...EMPTY, dir: target })
  log(`Second backup folder set: ${target}`)
  if (newestBackup) await copyToMirror(newestBackup)
  return mirrorStatus()
}

/** Stop copying. The copies already in the folder are left as they are. */
export function clearMirrorDir(): MirrorStatus {
  const was = readState().dir
  writeState({ ...EMPTY })
  if (was) log(`Second backup folder no longer used: ${was}`)
  return mirrorStatus()
}

/** Ask the coach for a folder with the system dialog. null when they cancel. */
export async function pickMirrorFolder(): Promise<string | null> {
  if (!picker) throw new MirrorError('Choosing a folder only works in the CoachBoard app.')
  return picker()
}
