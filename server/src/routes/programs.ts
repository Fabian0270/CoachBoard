import express, { Router, Request, Response } from 'express'
import { schemas, validate } from '../validation.js'
import { z } from 'zod'
import {
  findAllPrograms,
  findProgramById,
  createProgram,
  updateProgram,
  deleteProgram,
  setProgramDuration,
  createWorkout,
  updateWorkout,
  deleteWorkout,
  createExercise,
  updateExercise,
  deleteExercise,
  addSetToExercise,
  copyWorkoutDay,
  moveWorkoutDay,
  reorderExercises,
} from '../services/programService.js'
import { parseImportFile, commitImport } from '../services/importService.js'
import { parseExternalFile, commitExternalProgram } from '../services/externalImportService.js'
import { buildProgramWorkbook, ProgramExportError } from '../services/programExport.js'
import { buildProgramPreviewHtml } from '../services/programPreview.js'
import { createExportStyle } from '../services/exportStyleService.js'
import { sendProgramEmail } from '../services/emailService.js'
import { getProgramReport } from '../services/analysisService.js'
import { generateDraftProgram } from '../services/suggestionService.js'
import type { ExternalParseOverrides } from 'coachboard-shared'

const router = Router()

// Manual column/header remapping for the external importer, read from query params.
// header_row=N forces the header row; map_<field>=N pins a column (1-based), while
// map_<field>=none|'' clears a detected one; rpe_is_rir=1 marks the RPE column as
// RIR. Any param that's absent falls back to auto-detection.
function externalOverridesFromQuery(q: Request['query']): ExternalParseOverrides | undefined {
  const asInt = (v: unknown): number | undefined => {
    if (typeof v !== 'string' || v.trim() === '') return undefined
    const n = parseInt(v, 10)
    return Number.isFinite(n) ? n : undefined
  }
  // undefined = absent (auto), null = explicitly cleared, number = pinned column.
  const asColumn = (v: unknown): number | null | undefined => {
    if (v === undefined) return undefined
    if (v === '' || v === 'none') return null
    return asInt(v)
  }
  const o: ExternalParseOverrides = {}
  const hr = asInt(q.header_row); if (hr !== undefined) o.headerRow = hr
  const ex = asColumn(q.map_exercise); if (ex !== undefined) o.exercise = ex
  const sets = asColumn(q.map_sets); if (sets !== undefined) o.sets = sets
  const reps = asColumn(q.map_reps); if (reps !== undefined) o.reps = reps
  const load = asColumn(q.map_load); if (load !== undefined) o.load = load
  const rpe = asColumn(q.map_rpe); if (rpe !== undefined) o.rpe = rpe
  if (q.rpe_is_rir !== undefined) o.rpeFromRir = q.rpe_is_rir === '1' || q.rpe_is_rir === 'true'
  return Object.keys(o).length > 0 ? o : undefined
}

// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    let athleteId: string | undefined
    if (req.query.athlete_id !== undefined) {
      const parsed = z.uuid().safeParse(req.query.athlete_id)
      if (!parsed.success) { res.status(400).json({ error: 'Invalid athlete_id' }); return }
      athleteId = parsed.data
    }
    res.json(await findAllPrograms(athleteId))
  } catch {
    res.status(500).json({ error: 'Failed to fetch programs' })
  }
})

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const program = await findProgramById(String(req.params.id))
    if (!program) { res.status(404).json({ error: 'Program not found' }); return }
    res.json(program)
  } catch {
    res.status(500).json({ error: 'Failed to fetch program' })
  }
})

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.program.create, req.body, res)
  if (!body) return
  try {
    res.status(201).json(await createProgram(body))
  } catch {
    res.status(500).json({ error: 'Failed to create program' })
  }
})

router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.program.update, req.body, res)
  if (!body) return
  try {
    const updated = await updateProgram(String(req.params.id), body)
    if (!updated) { res.status(404).json({ error: 'Program not found' }); return }
    res.json(updated)
  } catch {
    res.status(500).json({ error: 'Failed to update program' })
  }
})

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await deleteProgram(String(req.params.id))
    if (!deleted) { res.status(404).json({ error: 'Program not found' }); return }
    res.status(204).send()
  } catch {
    res.status(500).json({ error: 'Failed to delete program' })
  }
})

router.put('/:programId/duration', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.program.duration, req.body, res)
  if (!body) return
  try {
    const updated = await setProgramDuration(String(req.params.programId), body.start_date, body.weeks)
    if (!updated) { res.status(404).json({ error: 'Program not found' }); return }
    res.json(updated)
  } catch {
    res.status(500).json({ error: 'Failed to update program duration' })
  }
})

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

router.post('/:programId/workouts', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.workout.create, req.body, res)
  if (!body) return
  try {
    const workout = await createWorkout({
      program_id: String(req.params.programId),
      name: body.name || body.scheduled_date || 'Workout',
      scheduled_date: body.scheduled_date,
      notes: body.notes,
    })
    res.status(201).json(workout)
  } catch {
    res.status(500).json({ error: 'Failed to create workout' })
  }
})

router.put('/:programId/workouts/:workoutId', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.workout.update, req.body, res)
  if (!body) return
  try {
    const updated = await updateWorkout(String(req.params.workoutId), String(req.params.programId), body)
    if (!updated) { res.status(404).json({ error: 'Workout not found' }); return }
    res.json(updated)
  } catch {
    res.status(500).json({ error: 'Failed to update workout' })
  }
})

router.delete('/:programId/workouts/:workoutId', async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await deleteWorkout(String(req.params.workoutId), String(req.params.programId))
    if (!deleted) { res.status(404).json({ error: 'Workout not found' }); return }
    res.status(204).send()
  } catch {
    res.status(500).json({ error: 'Failed to delete workout' })
  }
})

// ---------------------------------------------------------------------------
// Exercises
// ---------------------------------------------------------------------------

router.post('/:programId/workouts/:workoutId/exercises', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.exercise.create, req.body, res)
  if (!body) return
  try {
    const exercise = await createExercise({ workout_id: String(req.params.workoutId), ...body })
    res.status(201).json(exercise)
  } catch {
    res.status(500).json({ error: 'Failed to create exercise' })
  }
})

router.put('/:programId/workouts/:workoutId/exercises/reorder', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.reorderExercises, req.body, res)
  if (!body) return
  try {
    const result = await reorderExercises(
      String(req.params.workoutId),
      String(req.params.programId),
      body.exerciseIds,
    )
    if (!result) { res.status(404).json({ error: 'Workout not found' }); return }
    res.json({ exercises: result })
  } catch {
    res.status(500).json({ error: 'Failed to reorder exercises' })
  }
})

router.put('/:programId/workouts/:workoutId/exercises/:exerciseId', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.exercise.update, req.body, res)
  if (!body) return
  try {
    const updated = await updateExercise(String(req.params.exerciseId), String(req.params.workoutId), body)
    if (!updated) { res.status(404).json({ error: 'Exercise not found' }); return }
    res.json(updated)
  } catch {
    res.status(500).json({ error: 'Failed to update exercise' })
  }
})

router.delete('/:programId/workouts/:workoutId/exercises/:exerciseId', async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await deleteExercise(String(req.params.exerciseId), String(req.params.workoutId))
    if (!deleted) { res.status(404).json({ error: 'Exercise not found' }); return }
    res.status(204).send()
  } catch {
    res.status(500).json({ error: 'Failed to delete exercise' })
  }
})

router.post('/:programId/workouts/:workoutId/exercises/:exerciseId/add-set', async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await addSetToExercise(
      String(req.params.exerciseId),
      String(req.params.workoutId),
      String(req.params.programId),
    )
    if (!result) { res.status(404).json({ error: 'Exercise not found' }); return }
    res.status(201).json(result)
  } catch {
    res.status(500).json({ error: 'Failed to add set' })
  }
})

router.post('/:programId/move-day', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.moveDay, req.body, res)
  if (!body) return
  try {
    await moveWorkoutDay(String(req.params.programId), body.sourceDate, body.targetDate)
    res.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Move failed'
    res.status(msg.includes('No workout') ? 400 : 500).json({ error: msg })
  }
})

router.post('/:programId/copy-day', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.copyDay, req.body, res)
  if (!body) return
  try {
    const result = await copyWorkoutDay(String(req.params.programId), body.sourceDate, body.targetDates)
    res.json(result)
  } catch {
    res.status(500).json({ error: 'Failed to copy day' })
  }
})

// ---------------------------------------------------------------------------
// Program report — e1RM trends, RPE deviation, completion rate (Phase 3)
// ---------------------------------------------------------------------------

router.get('/:id/report', async (req: Request, res: Response): Promise<void> => {
  try {
    const report = await getProgramReport(String(req.params.id))
    if (!report) { res.status(404).json({ error: 'Program not found' }); return }
    res.json(report)
  } catch {
    res.status(500).json({ error: 'Failed to generate report' })
  }
})

router.post('/:id/suggest', async (req: Request, res: Response): Promise<void> => {
  const body = validate(schemas.suggestion, req.body, res)
  if (!body) return
  try {
    const result = await generateDraftProgram(String(req.params.id), body)
    res.status(201).json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Suggestion failed'
    const status = msg.includes('not found') || msg.includes('completed or archived') || msg.includes('Unknown template') ? 400 : 500
    res.status(status).json({ error: msg })
  }
})

// ---------------------------------------------------------------------------
// Export — workbook rendering lives in services/programExport.ts (shared with
// the email route below so the saved and emailed files can never drift).
// ---------------------------------------------------------------------------

router.get('/:id/export', async (req: Request, res: Response): Promise<void> => {
  try {
    const { buffer, safeName } = await buildProgramWorkbook(String(req.params.id))
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.xlsx"`)
    res.send(buffer)
  } catch (err) {
    if (err instanceof ProgramExportError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    res.status(500).json({ error: 'Failed to export program' })
  }
})

// HTML preview of the exact workbook that Download/Email would produce, so the
// coach can sanity-check styling in-app before sending. Reads back the real
// generated buffer (see services/programPreview.ts) — never re-derives layout.
router.get('/:id/export/preview', async (req: Request, res: Response): Promise<void> => {
  try {
    const html = await buildProgramPreviewHtml(String(req.params.id))
    res.json({ html })
  } catch (err) {
    if (err instanceof ProgramExportError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    res.status(500).json({ error: 'Failed to build the program preview' })
  }
})

// Email the same .xlsx straight to the athlete (Feature 6a). The workbook is
// regenerated through the exact same code path as Save to PC.
const sendEmailSchema = z.object({
  to: z.string().trim().email('A valid recipient email is required'),
  subject: z.string().trim().min(1, 'Subject is required').max(200),
  body: z.string().max(5000).optional().default(''),
})

router.post('/:id/send-email', async (req: Request, res: Response): Promise<void> => {
  const parsed = sendEmailSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' })
    return
  }
  const { to, subject, body } = parsed.data

  let workbook
  try {
    workbook = await buildProgramWorkbook(String(req.params.id))
  } catch (err) {
    if (err instanceof ProgramExportError) {
      res.status(err.status).json({ error: err.message })
      return
    }
    res.status(500).json({ error: 'Failed to build the program file' })
    return
  }

  const result = await sendProgramEmail({
    to,
    subject,
    body,
    attachmentName: `${workbook.safeName}.xlsx`,
    attachment: workbook.buffer,
  })
  if (!result.ok) {
    res.status(result.status).json({ error: result.error, code: result.code })
    return
  }
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Import — athletes fill in Load Used / Last Set RPE and send the sheet back
// ---------------------------------------------------------------------------

// dry_run=1 → parse file, return preview (no DB writes)
// no query param → parse file, commit, return summary
router.post(
  '/:id/import',
  express.raw({ type: 'application/octet-stream', limit: '10mb' }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const programId = String(req.params.id)
      const buffer = req.body as Buffer

      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        res.status(400).json({ error: 'Request body must be an xlsx file sent as application/octet-stream' })
        return
      }

      const preview = await parseImportFile(buffer, programId)

      if (req.query.dry_run === '1') {
        res.json(preview)
        return
      }

      const result = await commitImport(programId, preview.matched)
      res.json({ ...result, warnings: preview.warnings })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Import failed'
      res.status(500).json({ error: msg })
    }
  },
)

// ---------------------------------------------------------------------------
// External import (Feature 4) — arbitrary Excel files built outside CoachBoard.
// 4a: dry_run=1 parses the file and returns a structure preview. The commit
// path (creating the program) arrives in 4b.
// ---------------------------------------------------------------------------

router.post(
  '/import-external',
  express.raw({ type: 'application/octet-stream', limit: '10mb' }),
  async (req: Request, res: Response): Promise<void> => {
    try {
      const buffer = req.body as Buffer
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        res.status(400).json({ error: 'Request body must be an xlsx file sent as application/octet-stream' })
        return
      }

      const overrides = externalOverridesFromQuery(req.query)
      const preview = await parseExternalFile(buffer, overrides)

      // dry_run=1 → preview only (Feature 4a)
      if (req.query.dry_run === '1') {
        res.json(preview)
        return
      }

      // Otherwise commit: create a real program (Feature 4b)
      const meta = validate(schemas.externalImportCommit, req.query, res)
      if (!meta) return
      if (preview.errors.length > 0) {
        res.status(400).json({ error: preview.errors[0] })
        return
      }

      // Keep the original file bytes so the program (and any program based on it)
      // can re-export by re-filling the real sheet — preserving hyperlinks, merged
      // header boxes, eRPE formulas and exact layout the descriptor can't recreate.
      const templateXlsx = buffer.toString('base64')

      const result = await commitExternalProgram(preview.exercises, {
        athleteId: meta.athlete_id,
        name: meta.name,
        status: meta.status,
        startDate: meta.start_date ?? undefined,
        weeks: preview.weeks,
        focus: meta.focus ?? null,
        exportLayout: preview.layoutTemplate,
        templateXlsx,
      })

      // Opt-in: promote the captured layout + original file into the style library.
      if (meta.save_style && preview.layoutTemplate) {
        await createExportStyle(meta.style_name?.trim() || meta.name, preview.layoutTemplate, templateXlsx)
      }

      res.status(201).json(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'External import failed'
      res.status(msg.includes('not found') ? 400 : 500).json({ error: msg })
    }
  },
)

export default router
