import fsp from 'fs/promises'
import path from 'path'
import { getDb } from '../db.js'
import {
  deleteMediaFile,
  mediaRoot,
  resolveMediaAbsPath,
  thumbRelPath,
  writeMediaFile,
} from './mediaStore.js'

// ---------------------------------------------------------------------------
// Video poster frames (Feature 11a).
//
// Thumbnails are generated in the RENDERER, not here: Chromium already decodes
// the video for playback, so a hidden <video> drawn to a <canvas> gives us a
// frame for free. The alternative — ffmpeg — would add ~80 MB per platform to
// the installer and to every auto-update, for one JPEG per video.
//
// This module therefore only receives finished bytes, stores them, and owns the
// cleanup rules. The bytes arrive over HTTP from the app's own renderer, so they
// are validated (JPEG magic, size cap) at the route rather than trusted.
// ---------------------------------------------------------------------------

/** Why a video has no thumbnail. Mirrors DiscordMediaTable.thumb_status. */
export type ThumbStatus = 'ok' | 'unsupported' | 'failed'

export interface ThumbnailMeta {
  /** Intrinsic size as Chromium decoded it — NOT Discord's attachment metadata,
   *  which reports pre-rotation dimensions and disagrees for iPhone .mov. */
  width: number | null
  height: number | null
  durationMs: number | null
}

/** Stores a generated poster frame and the metadata captured in the same pass. */
export async function saveThumbnail(
  mediaId: string,
  jpeg: Buffer,
  meta: ThumbnailMeta,
): Promise<boolean> {
  const db = getDb()
  const row = await db
    .selectFrom('discord_media')
    .select(['id', 'posted_at', 'thumb_path'])
    .where('id', '=', mediaId)
    .executeTakeFirst()
  if (!row) return false

  const relPath = thumbRelPath(row.posted_at, mediaId)
  await writeMediaFile(relPath, jpeg)

  // Regenerating writes to the same path, but an older row could point somewhere
  // else if the bucketing scheme ever changes — clean up rather than orphan it.
  if (row.thumb_path && row.thumb_path !== relPath) {
    await deleteMediaFile(row.thumb_path)
  }

  await db
    .updateTable('discord_media')
    .set({
      thumb_path: relPath,
      thumb_status: 'ok',
      duration_ms: meta.durationMs,
      // Only fill dimensions we actually measured; never overwrite with null.
      ...(meta.width != null ? { width: meta.width } : {}),
      ...(meta.height != null ? { height: meta.height } : {}),
    })
    .where('id', '=', mediaId)
    .execute()

  return true
}

/**
 * Records that a thumbnail could not be produced. This is what stops the
 * renderer re-attempting a decode that can never succeed (an HEVC file on a
 * machine with no HEVC decoder) on every single scroll past the tile.
 */
export async function markThumbStatus(
  mediaId: string,
  status: Exclude<ThumbStatus, 'ok'>,
): Promise<boolean> {
  const res = await getDb()
    .updateTable('discord_media')
    .set({ thumb_status: status })
    .where('id', '=', mediaId)
    .executeTakeFirst()
  return Number(res.numUpdatedRows ?? 0n) > 0
}

/**
 * Deletes thumbnail files no media row claims.
 *
 * Not optional bookkeeping: deleteMediaFile returning false is NORMAL on Windows
 * when the file is open in the player, so a thumbnail whose delete lost that race
 * would sit on disk forever with its owning row already gone. Runs alongside the
 * retention sweep, where the cost of a directory walk is already being paid.
 */
export async function sweepOrphanThumbs(): Promise<number> {
  const root = path.join(mediaRoot(), 'thumbs')

  let months: string[]
  try {
    months = await fsp.readdir(root)
  } catch {
    return 0 // no thumbs directory yet — nothing to sweep
  }

  const rows = await getDb()
    .selectFrom('discord_media')
    .select('thumb_path')
    .where('thumb_path', 'is not', null)
    .execute()
  const claimed = new Set(rows.map((r) => r.thumb_path as string))

  let removed = 0
  for (const month of months) {
    let files: string[]
    try {
      files = await fsp.readdir(path.join(root, month))
    } catch {
      continue // a file where we expected a directory, or a race — skip it
    }
    for (const file of files) {
      const relPath = `media/thumbs/${month}/${file}`
      // .part files are in-flight writes from writeMediaFile; leave them alone.
      if (file.endsWith('.part') || claimed.has(relPath)) continue
      if (await deleteMediaFile(relPath)) removed++
    }
  }
  return removed
}

/** Absolute path of a stored thumbnail, or null if the row has none. */
export async function getThumbAbsPath(mediaId: string): Promise<string | null> {
  const row = await getDb()
    .selectFrom('discord_media')
    .select('thumb_path')
    .where('id', '=', mediaId)
    .executeTakeFirst()
  if (!row?.thumb_path) return null
  return resolveMediaAbsPath(row.thumb_path)
}
