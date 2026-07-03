import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { pipeline } from 'stream/promises'
import { Readable, Transform } from 'stream'
import { userDataDir } from './secureStore.js'

// ---------------------------------------------------------------------------
// Disk storage for synced media. Files live under userData/media with STABLE
// relative paths (stored in the DB with forward slashes) — files are never
// moved after download; the DB is the source of truth for ownership.
// ---------------------------------------------------------------------------

export function mediaRoot(): string {
  return path.join(userDataDir(), 'media')
}

/**
 * Resolves a DB-stored relative path to an absolute one, guarding against
 * anything escaping the media root (defense in depth — paths come from our
 * own DB, but the file route must never be able to serve outside media/).
 */
export function resolveMediaAbsPath(relPath: string): string {
  const root = mediaRoot()
  const rel = relPath.startsWith('media/') || relPath.startsWith('media\\')
    ? relPath.slice('media/'.length)
    : relPath
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('Media path escapes the media root')
  }
  return abs
}

// Windows-reserved device names — a file literally named CON.mp4 breaks fs on Windows.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\x00-\\x1f\\x7f]', 'g')

/** Makes a Discord attachment filename safe for every filesystem we ship to. */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(CONTROL_CHARS, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[. ]+|[. ]+$/g, '')

  const fallback = cleaned || 'attachment'
  const ext = path.extname(fallback)
  let base = path.basename(fallback, ext)
  if (WINDOWS_RESERVED.test(base)) base = `_${base}`
  // Cap total length but always keep the extension (playback depends on it).
  const maxBase = Math.max(1, 100 - ext.length)
  if (base.length > maxBase) base = base.slice(0, maxBase)
  return `${base}${ext}`
}

/**
 * Stable relative path for a Discord attachment:
 * media/discord/{yyyy-mm}/{messageId}_{attachmentId}_{filename}
 * The attachment id disambiguates multi-attachment messages where phones
 * name every file "video.mov".
 */
export function discordMediaRelPath(
  postedAt: string,
  messageId: string,
  attachmentId: string,
  filename: string,
): string {
  const month = postedAt.slice(0, 7) || 'unknown'
  return `media/discord/${month}/${messageId}_${attachmentId}_${sanitizeFilename(filename)}`
}

export class MediaTooLargeError extends Error {
  constructor(public bytes: number, public maxBytes: number) {
    super(`Attachment exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB size cap`)
    this.name = 'MediaTooLargeError'
  }
}

export class MediaDownloadError extends Error {
  constructor(public status: number) {
    super(`Media download failed with HTTP ${status}`)
    this.name = 'MediaDownloadError'
  }
}

/**
 * Streams a CDN URL to disk: writes to `{absPath}.part`, hashes while
 * streaming (never buffers the file), renames on success. On any failure the
 * .part file is removed — no half-files survive a crash of this function.
 */
export async function downloadToFile(
  url: string,
  absPath: string,
  opts: { maxBytes: number; fetchImpl?: typeof fetch },
): Promise<{ sha256: string; bytes: number }> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const res = await fetchImpl(url)
  if (!res.ok || !res.body) {
    throw new MediaDownloadError(res.status)
  }

  await fsp.mkdir(path.dirname(absPath), { recursive: true })
  const partPath = `${absPath}.part`
  const hash = crypto.createHash('sha256')
  let bytes = 0

  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length
      if (bytes > opts.maxBytes) {
        cb(new MediaTooLargeError(bytes, opts.maxBytes))
        return
      }
      hash.update(chunk)
      cb(null, chunk)
    },
  })

  try {
    await pipeline(
      Readable.fromWeb(res.body as import('stream/web').ReadableStream),
      counter,
      fs.createWriteStream(partPath),
    )
    await fsp.rename(partPath, absPath)
  } catch (err) {
    await fsp.unlink(partPath).catch(() => {})
    throw err
  }

  return { sha256: hash.digest('hex'), bytes }
}

/** Best-effort delete (purge flow) — locked/missing files are tolerated. */
export async function deleteMediaFile(relPath: string): Promise<boolean> {
  try {
    await fsp.unlink(resolveMediaAbsPath(relPath))
    return true
  } catch {
    return false
  }
}
