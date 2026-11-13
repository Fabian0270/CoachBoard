import type BetterSqlite3 from 'better-sqlite3'
import { createHash } from 'crypto'

// ---------------------------------------------------------------------------
// Moving imported workbooks out of programs and styles, into template_blobs.
//
// Before 1.17.0 each program and saved style held its whole imported .xlsx as
// base64 in a column of its own (programs.export_template_xlsx,
// export_styles.template_xlsx), and every program derived from an import copied
// it. This moves each distinct file into template_blobs once, points the rows at
// it by SHA-256, and only then drops the old columns, so the database and every
// later backup actually shrink. See services/templateBlobStore.ts.
//
// Synchronous and on the raw handle on purpose: it runs during start-up, before
// anything else touches the database, and better-sqlite3's transaction() gives
// an all-or-nothing backfill without Kysely's async plumbing.
// ---------------------------------------------------------------------------

export interface TemplateMigrationResult {
  /** Rows whose workbook was moved into template_blobs. */
  moved: number
  /** Whether a legacy column was dropped, so the file has pages to reclaim. */
  dropped: boolean
}

function columns(sqlite: BetterSqlite3.Database, table: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  return new Set(rows.map((r) => r.name))
}

/**
 * Moves one table's legacy column. Ids are read first and each workbook fetched
 * on its own: they are megabytes each, and better-sqlite3 cannot write while a
 * read is still iterating on the same connection.
 */
function backfill(
  sqlite: BetterSqlite3.Database,
  table: string,
  legacyColumn: string,
  shaColumn: string,
): number {
  const ids = sqlite
    .prepare(`SELECT id FROM ${table} WHERE ${legacyColumn} IS NOT NULL AND ${shaColumn} IS NULL`)
    .pluck()
    .all() as string[]
  const read = sqlite.prepare(`SELECT ${legacyColumn} FROM ${table} WHERE id = ?`).pluck()
  const insert = sqlite.prepare(
    'INSERT OR IGNORE INTO template_blobs (sha256, data, size_bytes, created_at) VALUES (?, ?, ?, ?)',
  )
  const point = sqlite.prepare(`UPDATE ${table} SET ${shaColumn} = ? WHERE id = ?`)
  const now = new Date().toISOString()
  for (const id of ids) {
    const base64 = read.get(id) as string
    const bytes = Buffer.from(base64, 'base64')
    const sha = createHash('sha256').update(bytes).digest('hex')
    insert.run(sha, bytes, bytes.length, now)
    point.run(sha, id)
  }
  return ids.length
}

/**
 * Rows that held a workbook but cannot reach one now. Must be zero before the
 * legacy column may go — that column is the only other copy.
 */
function unresolved(sqlite: BetterSqlite3.Database, table: string, legacyColumn: string, shaColumn: string): number {
  return sqlite
    .prepare(
      `SELECT COUNT(*) FROM ${table} t
        WHERE t.${legacyColumn} IS NOT NULL
          AND (t.${shaColumn} IS NULL
               OR NOT EXISTS (SELECT 1 FROM template_blobs b WHERE b.sha256 = t.${shaColumn}))`,
    )
    .pluck()
    .get() as number
}

/**
 * Expects template_blobs and both *_sha columns to exist already. Idempotent:
 * on a migrated database the legacy columns are gone and this does nothing.
 */
export function migrateTemplateBlobs(sqlite: BetterSqlite3.Database): TemplateMigrationResult {
  const targets = [
    { table: 'programs', legacy: 'export_template_xlsx', sha: 'export_template_sha' },
    { table: 'export_styles', legacy: 'template_xlsx', sha: 'template_sha' },
  ].filter((t) => columns(sqlite, t.table).has(t.legacy))
  if (targets.length === 0) return { moved: 0, dropped: false }

  let moved = 0
  sqlite.transaction(() => {
    for (const t of targets) moved += backfill(sqlite, t.table, t.legacy, t.sha)
    for (const t of targets) {
      const missing = unresolved(sqlite, t.table, t.legacy, t.sha)
      if (missing > 0) {
        // Throwing rolls the whole backfill back, leaving the database exactly
        // as it was — the old columns still hold every workbook.
        throw new Error(`${missing} ${t.table} row(s) lost their Excel template while moving it; nothing was changed`)
      }
    }
    // DROP COLUMN rewrites the table's rows without the column and, unlike a
    // DROP TABLE / RENAME rebuild, never drops `programs` — so the ON DELETE
    // CASCADE from workouts has no chance to fire.
    for (const t of targets) sqlite.exec(`ALTER TABLE ${t.table} DROP COLUMN ${t.legacy}`)
  })()

  return { moved, dropped: true }
}

/** Deletes workbooks no program or style points at. Returns how many. */
export function pruneOrphanTemplates(sqlite: BetterSqlite3.Database): number {
  return sqlite
    .prepare(
      `DELETE FROM template_blobs
        WHERE sha256 NOT IN (SELECT export_template_sha FROM programs WHERE export_template_sha IS NOT NULL)
          AND sha256 NOT IN (SELECT template_sha FROM export_styles WHERE template_sha IS NOT NULL)`,
    )
    .run().changes
}
