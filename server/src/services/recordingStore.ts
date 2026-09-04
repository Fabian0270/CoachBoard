import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { mediaRoot } from './mediaStore.js'

// ---------------------------------------------------------------------------
// Disk storage for feedback recordings (Feature 11c).
//
// Deliberately NOT in the database, and deliberately not permanent. A recording
// is discarded unless the coach saves or sends it, so there is no row to keep in
// step with the file and nothing to migrate. The folder is scratch space: on
// launch it is emptied, because anything that survived a restart is by
// definition abandoned.
//
// Chunks arrive during recording rather than as one upload at the end. A
// ten-minute walkthrough is ~130 MB, and holding that as a Blob in the renderer
// risks the process that is also compositing video — see the render-process-gone
// handler in electron/src/main.ts, which exists because that failure is silent.
// ---------------------------------------------------------------------------

/** Same month-bucketing rationale as thumbnails, minus the months: these are transient. */
function recordingsRoot(): string {
  return path.join(mediaRoot(), 'recordings')
}

/** Ids are ours, never user input, but the path is still built defensively. */
const ID_PATTERN = /^[0-9a-f-]{36}$/

function pathsFor(id: string): { part: string; final: string } {
  if (!ID_PATTERN.test(id)) throw new Error('Invalid recording id')
  const base = path.join(recordingsRoot(), id)
  return { part: `${base}.webm.part`, final: `${base}.webm` }
}

export interface RecordingInfo {
  id: string
  bytes: number
  /** True once finish() has run and the file is playable. */
  complete: boolean
}

/** The EBML magic every WebM file starts with. */
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])

export async function beginRecording(): Promise<string> {
  const id = crypto.randomUUID()
  await fsp.mkdir(recordingsRoot(), { recursive: true })
  // Created empty so an append to an unknown id can be rejected rather than
  // quietly conjuring a file.
  await fsp.writeFile(pathsFor(id).part, Buffer.alloc(0))
  return id
}

/**
 * Appends one MediaRecorder chunk.
 *
 * The first chunk carries the WebM header and is verified; later chunks are
 * continuation bytes with no magic of their own, so only the first can be
 * checked. Same "our own renderer, but this writes to disk, so verify rather
 * than trust" posture as the thumbnail upload route.
 */
export async function appendChunk(id: string, data: Buffer): Promise<number> {
  const { part } = pathsFor(id)
  const stat = await fsp.stat(part).catch(() => null)
  if (!stat) throw new Error('No such recording')

  if (stat.size === 0 && !data.subarray(0, 4).equals(WEBM_MAGIC)) {
    throw new Error('Expected a WebM body')
  }

  await fsp.appendFile(part, data)
  return stat.size + data.length
}

/**
 * Seals the recording.
 *
 * Rename rather than copy, so a reader can never observe a half-written file —
 * the same discipline as mediaStore.writeMediaFile, for the same reason.
 */
export async function finishRecording(id: string): Promise<RecordingInfo> {
  const { part, final } = pathsFor(id)
  const stat = await fsp.stat(part).catch(() => null)
  if (!stat) throw new Error('No such recording')
  if (stat.size === 0) {
    // Nothing was ever captured. Leaving a zero-byte .webm behind would give
    // the coach a file that looks real and plays as nothing.
    await fsp.rm(part, { force: true })
    throw new Error('Recording is empty')
  }
  await fsp.rename(part, final)
  return { id, bytes: stat.size, complete: true }
}

export async function statRecording(id: string): Promise<RecordingInfo | null> {
  const { part, final } = pathsFor(id)
  const done = await fsp.stat(final).catch(() => null)
  if (done) return { id, bytes: done.size, complete: true }
  const partial = await fsp.stat(part).catch(() => null)
  if (partial) return { id, bytes: partial.size, complete: false }
  return null
}

/** Absolute path for the file route to stream. Null when it is not finished. */
export async function recordingPath(id: string): Promise<string | null> {
  const { final } = pathsFor(id)
  return (await fsp.stat(final).catch(() => null)) ? final : null
}

/** Removes both forms, so a discard during recording leaves nothing behind. */
export async function deleteRecording(id: string): Promise<void> {
  const { part, final } = pathsFor(id)
  await Promise.all([fsp.rm(part, { force: true }), fsp.rm(final, { force: true })])
}

/**
 * Empties the folder at launch.
 *
 * Recordings are ephemeral by design, so anything still here after a restart is
 * abandoned — an interrupted recording, or one whose review dialog never got
 * answered. Keeping them would grow the coach's disk forever with files they
 * already decided not to keep.
 */
export async function sweepRecordings(): Promise<number> {
  const root = recordingsRoot()
  const entries = await fsp.readdir(root).catch(() => null)
  if (!entries) return 0
  let removed = 0
  for (const entry of entries) {
    if (!entry.endsWith('.webm') && !entry.endsWith('.webm.part')) continue
    await fsp.rm(path.join(root, entry), { force: true }).then(
      () => removed++,
      () => {
        /* locked by a player on Windows; the next sweep gets it */
      },
    )
  }
  return removed
}
