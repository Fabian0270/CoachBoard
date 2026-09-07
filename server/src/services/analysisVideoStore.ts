import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { mediaRoot, resolveMediaAbsPath } from './mediaStore.js'

// ---------------------------------------------------------------------------
// The video behind a saved bar-path analysis (Feature 11b follow-up).
//
// Deliberately NOT the same thing as recordingStore, which is scratch space
// wiped at launch. This is the opposite: a file the coach chose to keep, owned
// by a row, living exactly as long as the analysis does.
//
// Only LOCAL imports land here. A Discord clip is already on disk under
// discord_media.local_path, and copying 50-500 MB to own a second identical
// file would be waste — for those the analysis references the existing file and
// the retention carve-out protects it.
//
// Uploads arrive in chunks rather than one body: a lift clip can be hundreds of
// megabytes, and a single buffered request would hold all of it in memory in
// the same process that serves the app.
// ---------------------------------------------------------------------------

function videosRoot(): string {
  return path.join(mediaRoot(), 'analyses')
}

/** Ids are ours, never user input, and the path is still built defensively. */
const ID_PATTERN = /^[0-9a-f-]{36}$/

/**
 * Extensions we are willing to name a file with.
 *
 * The extension is the only part of a coach-supplied filename that survives
 * into the path, and playback depends on it — so it is an allowlist rather
 * than a sanitiser. Anything else becomes .mp4, which is what a phone produces.
 */
const ALLOWED_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv'])

function extensionFor(filename: string | undefined): string {
  const ext = path.extname(filename ?? '').toLowerCase()
  return ALLOWED_EXT.has(ext) ? ext : '.mp4'
}

function pathsFor(id: string, ext: string): { part: string; final: string } {
  if (!ID_PATTERN.test(id)) throw new Error('Invalid video id')
  const rel = `analyses/${id}${ext}`
  const abs = resolveMediaAbsPath(rel)
  return { part: `${abs}.part`, final: abs }
}

export interface StoredVideo {
  /** DB-stored relative path, forward slashes, as every other media path is. */
  relPath: string
  bytes: number
}

/** Starts an upload and returns the id the chunks will be appended under. */
export async function beginVideo(filename?: string): Promise<{ id: string; ext: string }> {
  const id = crypto.randomUUID()
  const ext = extensionFor(filename)
  await fsp.mkdir(videosRoot(), { recursive: true })
  // Created empty so an append to an unknown id is rejected rather than
  // quietly conjuring a file — same discipline as recordingStore.
  await fsp.writeFile(pathsFor(id, ext).part, Buffer.alloc(0))
  return { id, ext }
}

/** Largest video we will store. Matches the Discord sync's own download cap. */
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024

export async function appendVideoChunk(id: string, ext: string, data: Buffer): Promise<number> {
  const { part } = pathsFor(id, ext)
  const stat = await fsp.stat(part).catch(() => null)
  if (!stat) throw new Error('No such upload')
  const total = stat.size + data.length
  if (total > MAX_VIDEO_BYTES) {
    // Stop at the cap rather than letting a runaway upload fill the disk. The
    // partial file goes with it: half a video is not worth keeping.
    await fsp.rm(part, { force: true })
    throw new Error('That video is too large to keep')
  }
  await fsp.appendFile(part, data)
  return total
}

/** Seals the upload. Rename, so a reader never sees a half-written file. */
export async function finishVideo(id: string, ext: string): Promise<StoredVideo> {
  const { part, final } = pathsFor(id, ext)
  const stat = await fsp.stat(part).catch(() => null)
  if (!stat) throw new Error('No such upload')
  if (stat.size === 0) {
    await fsp.rm(part, { force: true })
    throw new Error('That video was empty')
  }
  await fsp.rename(part, final)
  return { relPath: `analyses/${id}${ext}`, bytes: stat.size }
}

/** Absolute path for the file route, or null when it is gone. */
export async function videoPath(relPath: string): Promise<string | null> {
  let abs: string
  try {
    abs = resolveMediaAbsPath(relPath)
  } catch {
    return null
  }
  return (await fsp.stat(abs).catch(() => null)) ? abs : null
}

/** Best-effort: a locked file on Windows is normal, and the sweep will get it. */
export async function deleteVideo(relPath: string | null | undefined): Promise<void> {
  if (!relPath) return
  try {
    await fsp.rm(resolveMediaAbsPath(relPath), { force: true })
  } catch {
    /* outside the root, locked, or already gone */
  }
}

/**
 * Deletes stored videos no analysis claims any more.
 *
 * The DB is the source of truth and the disk gets reconciled to it — the same
 * shape as sweepOrphanThumbs, and needed for the same reason: deleting a file
 * can legitimately fail while a player still holds it open on Windows, which
 * would otherwise strand it forever. `.part` files are skipped because they are
 * in-flight uploads, not orphans.
 */
export async function sweepOrphanVideos(claimed: Set<string>): Promise<number> {
  const root = videosRoot()
  const entries = await fsp.readdir(root).catch(() => null)
  if (!entries) return 0
  let removed = 0
  for (const entry of entries) {
    if (entry.endsWith('.part')) continue
    if (claimed.has(`analyses/${entry}`)) continue
    await fsp.rm(path.join(root, entry), { force: true }).then(
      () => removed++,
      () => {
        /* locked; the next sweep gets it */
      },
    )
  }
  return removed
}
