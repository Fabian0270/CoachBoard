import { findProgramForExport } from './programService.js'
import { renderProgramWorkbook } from './exportService.js'
import { renderScaffold } from './templateScaffoldService.js'

// ---------------------------------------------------------------------------
// Single source of truth for "turn a program into its .xlsx buffer", shared by
// the GET /:id/export download route and the POST /:id/send-email route so the
// emailed file can never drift from the saved one.
// ---------------------------------------------------------------------------

export class ProgramExportError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'ProgramExportError'
  }
}

export interface BuiltWorkbook {
  /** The rendered .xlsx as a Buffer. */
  buffer: Buffer
  /** Filesystem-safe base name (no extension), e.g. for Content-Disposition. */
  safeName: string
  /** The program's display name, for email subjects/bodies. */
  programName: string
}

/**
 * Render a program to its .xlsx workbook. Prefers rebuilding the coach's captured
 * style as a scaffold around this program's content; falls back to the generic /
 * descriptor renderer when there's no stored original or its layout isn't supported.
 *
 * Throws {@link ProgramExportError} with an HTTP status when the program is missing
 * or has no date range yet.
 */
export async function buildProgramWorkbook(programId: string): Promise<BuiltWorkbook> {
  const data = await findProgramForExport(programId)
  if (!data) throw new ProgramExportError(404, 'Program not found')
  const { program, workouts, exercises } = data

  if (!program.start_date || !program.end_date) {
    throw new ProgramExportError(400, 'Program needs a date range before export')
  }

  let buffer: Buffer | null = null
  if (program.export_template_xlsx) {
    try {
      buffer = await renderScaffold(program.export_template_xlsx, program, workouts, exercises)
    } catch {
      buffer = null // any scaffold failure → fall back to the renderer below
    }
  }
  if (!buffer) buffer = await renderProgramWorkbook(program, workouts, exercises)

  const programName = program.name || 'program'
  const safeName =
    programName.replace(/[^\w\s-]/g, '_').replace(/\s+/g, '_').slice(0, 60) || 'program'
  return { buffer, safeName, programName }
}
