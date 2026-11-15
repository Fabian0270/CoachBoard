import { findProgramForExport } from './programService.js'
import { renderProgramWorkbook } from './exportService.js'
import { renderScaffold, ScaffoldDoesNotFitError } from './templateScaffoldService.js'
import { logError } from '../lib/logger.js'
import { loadTemplate } from './templateBlobStore.js'
import { latestE1RMByLift } from './analysisService.js'
import { MINIMAL_DESCRIPTOR } from 'coachboard-shared/exportLayout'

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
  /**
   * Set when the coach's imported style could not be used for this export and
   * the built-in look was used instead — said in the preview, so the switch is
   * never a surprise when the athlete opens the file.
   */
  notice: string | null
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
  let notice: string | null = null
  const templateXlsx = await loadTemplate(program.export_template_sha)
  if (program.export_template_sha && !templateXlsx) {
    // A key with nothing behind it. Should not happen — the import stores both
    // in one transaction — but if it does the coach is told, not handed a
    // different look without a word.
    notice = "Your imported Excel style could not be found, so CoachBoard's own layout was used."
    logError(`Program ${programId} points at a missing Excel template`, `no stored workbook for ${program.export_template_sha}`)
  }
  if (templateXlsx) {
    try {
      buffer = await renderScaffold(templateXlsx, program, workouts, exercises)
      // Null means the template's layout is one the styled export cannot
      // reproduce. Same outcome as a failure, and it was just as silent.
      if (!buffer) {
        notice = "Your imported Excel style's layout can't be reproduced for this program, so CoachBoard's own layout is used."
      }
    } catch (err) {
      // Any scaffold failure → fall back to the generic renderer below, which
      // always carries every exercise. A program that simply outgrew its
      // template is an expected case with its own explanation; anything else is
      // a fault, and goes to the real log file — this used console.error, which
      // a packaged app writes nowhere a coach or a bug report can reach.
      buffer = null
      if (err instanceof ScaffoldDoesNotFitError) {
        notice = err.message
      } else {
        notice = "Your imported Excel style could not be used for this export, so CoachBoard's own layout was used."
        logError(`Styled export failed for program ${programId} ("${program.name ?? ''}")`, err)
      }
    }
  }
  if (!buffer) {
    // No imported coach style → render the program's chosen built-in look. A coach
    // descriptor (export_layout) still takes precedence over the built-in default.
    const builtin = program.builtin_template ?? 'coachboard'
    if (!program.export_layout && builtin === 'modern') {
      const e1rmRef = latestE1RMByLift(program, workouts, exercises)
      buffer = await renderProgramWorkbook(program, workouts, exercises, { modern: { e1rmRef } })
    } else if (!program.export_layout && builtin === 'minimal') {
      buffer = await renderProgramWorkbook(program, workouts, exercises, { templateOverride: MINIMAL_DESCRIPTOR })
    } else {
      buffer = await renderProgramWorkbook(program, workouts, exercises)
    }
  }

  const programName = program.name || 'program'
  const safeName =
    programName.replace(/[^\w\s-]/g, '_').replace(/\s+/g, '_').slice(0, 60) || 'program'
  return { buffer, safeName, programName, notice }
}
