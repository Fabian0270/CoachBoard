import { createHash } from 'crypto'
import type { Kysely } from 'kysely'
import { getDb, type DB } from '../db.js'

// ---------------------------------------------------------------------------
// The coach's imported Excel workbooks, stored once each.
//
// Programs and saved styles used to carry the whole workbook as base64 in a
// column of their own, and every program or draft derived from an import copied
// it. Twelve blocks off one import was ~32 MB of identical text, riding along in
// every rolling backup. Now a row holds the SHA-256 of the file's bytes and the
// bytes live here, once, however many rows point at them.
//
// The API still speaks base64 because that is what the import route produces and
// what the scaffold renderer takes; the conversion happens only at this edge.
// ---------------------------------------------------------------------------

type Db = Kysely<DB>

/** SHA-256 of the decoded bytes, hex. Same file → same key, however it was encoded. */
export function templateSha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Stores a workbook if it is not already stored, and returns its key.
 *
 * Takes the database handle so an import can store the file inside the same
 * transaction that creates the program pointing at it.
 */
export async function storeTemplate(base64: string, db: Db = getDb()): Promise<string> {
  const bytes = Buffer.from(base64, 'base64')
  const sha = templateSha(bytes)
  await db
    .insertInto('template_blobs')
    .values({ sha256: sha, data: bytes, size_bytes: bytes.length, created_at: new Date().toISOString() })
    .onConflict((oc) => oc.column('sha256').doNothing())
    .execute()
  return sha
}

/** The workbook as base64, or null when there is none under that key. */
export async function loadTemplate(sha: string | null | undefined, db: Db = getDb()): Promise<string | null> {
  if (!sha) return null
  const row = await db
    .selectFrom('template_blobs')
    .select('data')
    .where('sha256', '=', sha)
    .executeTakeFirst()
  return row ? Buffer.from(row.data).toString('base64') : null
}

// Workbooks nothing points at any more are deleted at start-up — see
// pruneOrphanTemplates in templateBlobMigration.ts.
