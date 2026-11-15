import fs from 'fs'
import { getDb, getDatabasePath } from '../db.js'
import { backupStorage } from './backupService.js'
import { getStorageUsage } from './discordMediaService.js'

// ---------------------------------------------------------------------------
// Where the coach's disk space goes.
//
// The only storage figure the app used to show was Discord media, and only on
// the Dashboard once Discord was set up. A coach whose data folder had grown to
// gigabytes had no way to see why. Everything here is already recorded — sizes
// are summed from the database or stat'd from a handful of known files — so no
// folder is walked to answer it.
// ---------------------------------------------------------------------------

export interface StorageItem {
  bytes: number
  files: number
}

export interface StorageBreakdown {
  /** The database file: athletes, programs, analyses, settings. */
  database: StorageItem
  /** Imported Excel workbooks — stored INSIDE the database, so part of its size. */
  excelTemplates: StorageItem
  /** The rolling copies taken at launch. */
  backups: StorageItem
  /** Videos synced from Discord. */
  discordMedia: StorageItem
  /** Clips kept with saved bar-path analyses. */
  analysisVideos: StorageItem
  /** database + backups + discordMedia + analysisVideos (templates are inside the database). */
  totalBytes: number
}

const fileSize = (file: string): number => {
  try {
    return fs.statSync(file).size
  } catch {
    return 0 // :memory: under test, or not written yet
  }
}

export async function getStorageBreakdown(): Promise<StorageBreakdown> {
  const db = getDb()
  const [templates, analyses, discordMedia] = await Promise.all([
    db
      .selectFrom('template_blobs')
      .select((eb) => [eb.fn.sum<number>('size_bytes').as('bytes'), eb.fn.countAll<number>().as('files')])
      .executeTakeFirst(),
    db
      .selectFrom('video_analyses')
      .select((eb) => [eb.fn.sum<number>('video_bytes').as('bytes'), eb.fn.countAll<number>().as('files')])
      .where('video_path', 'is not', null)
      .executeTakeFirst(),
    getStorageUsage(),
  ])

  const database = { bytes: fileSize(getDatabasePath()), files: 1 }
  const backups = backupStorage()
  const analysisVideos = { bytes: Number(analyses?.bytes ?? 0), files: Number(analyses?.files ?? 0) }
  return {
    database,
    excelTemplates: { bytes: Number(templates?.bytes ?? 0), files: Number(templates?.files ?? 0) },
    backups,
    discordMedia,
    analysisVideos,
    totalBytes: database.bytes + backups.bytes + discordMedia.bytes + analysisVideos.bytes,
  }
}
