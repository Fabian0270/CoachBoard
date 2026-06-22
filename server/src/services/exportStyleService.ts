import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../db.js'
import type { ExportLayoutTemplate, ExportStyle } from 'coachboard-shared'
import { parseExportLayout } from 'coachboard-shared/exportLayout'

// ---------------------------------------------------------------------------
// Export style library — opt-in, reusable saved styles (the import step's
// "save this program's style for future programs" toggle). Independent of any
// one program so a saved style survives program deletion and can be reused
// across athletes.
// ---------------------------------------------------------------------------

/** All saved styles, newest first; rows with unparseable descriptors are skipped.
 *  The (potentially large) template_xlsx bytes are NOT included in the list. */
export async function findAllExportStyles(): Promise<ExportStyle[]> {
  const rows = await getDb()
    .selectFrom('export_styles')
    .select(['id', 'name', 'descriptor', 'created_at'])
    .orderBy('created_at', 'desc')
    .execute()
  return rows.flatMap((row) => {
    const descriptor = parseExportLayout(row.descriptor)
    if (!descriptor) return []
    return [{ id: row.id, name: row.name, descriptor, created_at: row.created_at }]
  })
}

export async function createExportStyle(
  name: string,
  descriptor: ExportLayoutTemplate,
  templateXlsx?: string | null,
): Promise<ExportStyle> {
  const now = new Date().toISOString()
  const id = uuidv4()
  await getDb()
    .insertInto('export_styles')
    .values({ id, name, descriptor: JSON.stringify(descriptor), template_xlsx: templateXlsx ?? null, created_at: now })
    .execute()
  return { id, name, descriptor, created_at: now }
}

export async function deleteExportStyle(id: string): Promise<boolean> {
  const row = await getDb()
    .deleteFrom('export_styles')
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirst()
  return !!row
}
