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
//
// Tracks. A recording is up to three files side by side, each written in
// chunks and sealed by rename the same way:
//   screen  <id>.webm        — what was captured, with sound; no webcam drawn in
//   camera  <id>.cam.webm    — the webcam on its own, when the coach used one
//   final   <id>.final.webm  — the edited result (webcam placed, trimmed)
// The webcam used to be drawn into the screen recording while it was being
// made, which baked its position in. Keeping it separate is what lets the coach
// move, resize or hide it — and trim — after stopping.
// ---------------------------------------------------------------------------

/** Same month-bucketing rationale as thumbnails, minus the months: these are transient. */
function recordingsRoot(): string {
  return path.join(mediaRoot(), 'recordings')
}

export type RecordingTrack = 'screen' | 'camera' | 'final'

export const RECORDING_TRACKS: readonly RecordingTrack[] = ['screen', 'camera', 'final']

const SUFFIX: Record<RecordingTrack, string> = {
  screen: '.webm',
  camera: '.cam.webm',
  final: '.final.webm',
}

/** Ids are ours, never user input, but the path is still built defensively. */
const ID_PATTERN = /^[0-9a-f-]{36}$/

function pathsFor(id: string, track: RecordingTrack = 'screen'): { part: string; final: string } {
  if (!ID_PATTERN.test(id)) throw new Error('Invalid recording id')
  const base = path.join(recordingsRoot(), id) + SUFFIX[track]
  return { part: `${base}.part`, final: base }
}

const exists = async (p: string): Promise<boolean> => !!(await fsp.stat(p).catch(() => null))

export interface RecordingInfo {
  id: string
  /** Size of what would be saved or sent: the edited result when there is one. */
  bytes: number
  /** True once the screen track is sealed and playable. */
  complete: boolean
  /** A webcam track was recorded alongside. */
  hasCamera: boolean
  /** An edited result exists, and is what saving and sending use. */
  edited: boolean
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
 * Starts (or restarts) the camera or final track of an existing recording.
 * Restarting matters for `final`: each export replaces the previous one.
 */
export async function beginTrack(id: string, track: Exclude<RecordingTrack, 'screen'>): Promise<void> {
  const screen = pathsFor(id, 'screen')
  if (!(await exists(screen.part)) && !(await exists(screen.final))) throw new Error('No such recording')
  const { part, final } = pathsFor(id, track)
  if (track === 'final') await fsp.rm(final, { force: true })
  await fsp.writeFile(part, Buffer.alloc(0))
}

/**
 * Appends one chunk to a track.
 *
 * The first chunk carries the WebM header and is verified; later chunks are
 * continuation bytes with no magic of their own, so only the first can be
 * checked. Same "our own renderer, but this writes to disk, so verify rather
 * than trust" posture as the thumbnail upload route.
 */
export async function appendChunk(id: string, data: Buffer, track: RecordingTrack = 'screen'): Promise<number> {
  const { part } = pathsFor(id, track)
  const stat = await fsp.stat(part).catch(() => null)
  if (!stat) throw new Error('No such recording')

  if (stat.size === 0 && !data.subarray(0, 4).equals(WEBM_MAGIC)) {
    throw new Error('Expected a WebM body')
  }

  await fsp.appendFile(part, data)
  return stat.size + data.length
}

/**
 * Writes bytes at a given offset of the edited result while it is being made.
 *
 * The export streams its output here as it goes rather than holding a whole
 * video in the renderer's memory (see the note at the top). A WebM writer goes
 * back to fill in sizes, the duration and the seek index once it knows them, so
 * the writes are positioned, not appended. Only the `final` track takes these.
 */
export async function writeAt(id: string, position: number, data: Buffer): Promise<number> {
  if (!Number.isSafeInteger(position) || position < 0) throw new Error('Invalid position')
  const { part } = pathsFor(id, 'final')
  if (!(await exists(part))) throw new Error('No such recording')
  if (position === 0 && data.length >= 4 && !data.subarray(0, 4).equals(WEBM_MAGIC)) {
    throw new Error('Expected a WebM body')
  }
  const handle = await fsp.open(part, 'r+')
  try {
    await handle.write(data, 0, data.length, position)
    return (await handle.stat()).size
  } finally {
    await handle.close()
  }
}

/**
 * Seals a track.
 *
 * Rename rather than copy, so a reader can never observe a half-written file —
 * the same discipline as mediaStore.writeMediaFile, for the same reason.
 */
export async function finishRecording(id: string, track: RecordingTrack = 'screen'): Promise<RecordingInfo> {
  const { part, final } = pathsFor(id, track)
  const stat = await fsp.stat(part).catch(() => null)
  if (!stat) throw new Error('No such recording')
  if (stat.size === 0) {
    await fsp.rm(part, { force: true })
    // Nothing was ever captured. A zero-byte .webm would look real and play as
    // nothing. A webcam that produced nothing just means "no webcam".
    if (track !== 'camera') throw new Error('Recording is empty')
  } else {
    await fsp.rename(part, final)
  }
  const info = await statRecording(id)
  if (!info) throw new Error('No such recording')
  return info
}

export async function statRecording(id: string): Promise<RecordingInfo | null> {
  const screen = pathsFor(id, 'screen')
  const done = await fsp.stat(screen.final).catch(() => null)
  const partial = done ? null : await fsp.stat(screen.part).catch(() => null)
  if (!done && !partial) return null
  const edited = await fsp.stat(pathsFor(id, 'final').final).catch(() => null)
  return {
    id,
    bytes: edited?.size ?? done?.size ?? partial?.size ?? 0,
    complete: !!done,
    hasCamera: await exists(pathsFor(id, 'camera').final),
    edited: !!edited,
  }
}

/**
 * The file to save or send: the edited result when there is one, otherwise
 * the screen recording. Null while it is still being recorded.
 */
export async function recordingPath(id: string): Promise<string | null> {
  const edited = pathsFor(id, 'final').final
  if (await exists(edited)) return edited
  const { final } = pathsFor(id, 'screen')
  return (await exists(final)) ? final : null
}

/** A specific sealed track (the editor needs the raw screen and camera). Null when absent. */
export async function trackPath(id: string, track: RecordingTrack): Promise<string | null> {
  const { final } = pathsFor(id, track)
  return (await exists(final)) ? final : null
}

/** Drops the edited result, so saving and sending fall back to the screen recording. */
export async function discardEdit(id: string): Promise<void> {
  const { part, final } = pathsFor(id, 'final')
  await Promise.all([fsp.rm(part, { force: true }), fsp.rm(final, { force: true })])
}

/** Removes every track in every state, so a discard during recording leaves nothing behind. */
export async function deleteRecording(id: string): Promise<void> {
  await Promise.all(
    RECORDING_TRACKS.flatMap((track) => {
      const { part, final } = pathsFor(id, track)
      return [fsp.rm(part, { force: true }), fsp.rm(final, { force: true })]
    }),
  )
}

/**
 * Empties the folder at launch.
 *
 * Recordings are ephemeral by design, so anything still here after a restart is
 * abandoned — an interrupted recording, or one whose review dialog never got
 * answered. Keeping them would grow the coach's disk forever with files they
 * already decided not to keep. Every track ends in .webm or .webm.part.
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
