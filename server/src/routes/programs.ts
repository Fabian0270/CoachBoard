import express, { Router, Request, Response } from 'express'
import ExcelJS from 'exceljs'
import { schemas, validate } from '../validation.js'
import { z } from 'zod'
import {
  findAllPrograms,
  findProgramById,
  findProgramForExport,
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
import { getProgramReport } from '../services/analysisService.js'
import { generateDraftProgram } from '../services/suggestionService.js'

const router = Router()

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
// Export — presentation logic stays in the route; data access via service
// ---------------------------------------------------------------------------

const TOGGLEABLE_COLUMNS = ['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe'] as const
type ToggleableColumn = typeof TOGGLEABLE_COLUMNS[number]

router.get('/:id/export', async (req: Request, res: Response): Promise<void> => {
  try {
    const data = await findProgramForExport(String(req.params.id))
    if (!data) { res.status(404).json({ error: 'Program not found' }); return }
    const { program, workouts, exercises } = data

    if (!program.start_date || !program.end_date) {
      res.status(400).json({ error: 'Program needs a date range before export' })
      return
    }

    const enabledSet = (() => {
      if (!program.enabled_columns) return new Set(TOGGLEABLE_COLUMNS as readonly string[])
      try {
        const parsed = JSON.parse(program.enabled_columns)
        if (Array.isArray(parsed)) return new Set(parsed.filter((c) => typeof c === 'string'))
      } catch { /* fall through */ }
      return new Set(TOGGLEABLE_COLUMNS as readonly string[])
    })()
    const isEnabled = (k: ToggleableColumn) => enabledSet.has(k)

    const toIso = (d: Date) => d.toISOString().slice(0, 10)
    const mondayOf = (date: Date) => {
      const offset = date.getUTCDay() === 0 ? -6 : 1 - date.getUTCDay()
      const m = new Date(date)
      m.setUTCDate(date.getUTCDate() + offset)
      return m
    }

    const exercisesByWorkout = new Map<string, typeof exercises>()
    for (const ex of exercises) {
      const list = exercisesByWorkout.get(ex.workout_id) ?? []
      list.push(ex)
      exercisesByWorkout.set(ex.workout_id, list)
    }
    const workoutByDate = new Map<string, typeof workouts[number]>()
    for (const w of workouts) {
      if (w.scheduled_date) workoutByDate.set(w.scheduled_date, w)
    }

    const [sy, sm, sd] = program.start_date.split('-').map(Number)
    const [ey, em, ed] = program.end_date.split('-').map(Number)
    const startMonday = mondayOf(new Date(Date.UTC(sy, sm - 1, sd)))
    const endDate = new Date(Date.UTC(ey, em - 1, ed))
    const numWeeks = Math.max(1, Math.ceil((Math.round((endDate.getTime() - startMonday.getTime()) / 86400000) + 1) / 7))

    type ExerciseRow = typeof exercises[number]
    const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    const dayData: Array<{ perWeek: ExerciseRow[][]; maxRows: number }> = []
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
      const perWeek: ExerciseRow[][] = []
      let maxRows = 0
      for (let weekIndex = 0; weekIndex < numWeeks; weekIndex++) {
        const date = new Date(startMonday)
        date.setUTCDate(startMonday.getUTCDate() + weekIndex * 7 + dayOfWeek)
        const workout = workoutByDate.get(toIso(date))
        const exList = workout ? exercisesByWorkout.get(workout.id) ?? [] : []
        perWeek.push(exList)
        if (exList.length > maxRows) maxRows = exList.length
      }
      dayData.push({ perWeek, maxRows })
    }

    type ExportColumn = { key: string; label: string; color: string; width: number; get: (ex: ExerciseRow) => string | number | null }
    const HEADER_COLOR = 'FFB39DDB'
    const TRACKING_COLOR = 'FF4DB6AC'
    const exportColumns: ExportColumn[] = []
    exportColumns.push({ key: 'name', label: 'Discipline', color: HEADER_COLOR, width: 22, get: (ex) => ex.name ?? '' })
    if (isEnabled('rest_time')) exportColumns.push({ key: 'rest_time', label: 'Rest Time (mins)', color: HEADER_COLOR, width: 12, get: (ex) => ex.rest_time ?? '' })
    exportColumns.push({ key: 'sets', label: 'Sets', color: HEADER_COLOR, width: 6, get: (ex) => ex.sets ?? '' })
    exportColumns.push({ key: 'reps', label: 'Reps', color: HEADER_COLOR, width: 6, get: (ex) => ex.reps ?? '' })
    if (isEnabled('intensity')) exportColumns.push({ key: 'intensity', label: 'Intensity/Weight', color: HEADER_COLOR, width: 16, get: (ex) => ex.intensity ?? '' })
    if (isEnabled('load_cap')) exportColumns.push({ key: 'load_cap', label: 'Load Cap', color: TRACKING_COLOR, width: 10, get: (ex) => ex.weight ?? '' })
    if (isEnabled('load_used')) exportColumns.push({ key: 'load_used', label: 'Load Used', color: TRACKING_COLOR, width: 10, get: (ex) => ex.load_used ?? '' })
    if (isEnabled('rpe')) exportColumns.push({ key: 'rpe', label: 'Last Set RPE', color: TRACKING_COLOR, width: 13, get: (ex) => ex.rpe ?? '' })

    const fixedColumnCount = 1
    const exportColumnCount = exportColumns.length
    const weekColumnStart = (weekIndex: number) => fixedColumnCount + 1 + weekIndex * (exportColumnCount + 1)
    const totalCols = fixedColumnCount + numWeeks * exportColumnCount + (numWeeks - 1)

    const RED = 'FFE57373'
    const BORDER_COLOR = 'FFCCCCCC'
    const fill = (argb: string): ExcelJS.FillPattern => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } })
    const border: ExcelJS.Border = { style: 'thin', color: { argb: BORDER_COLOR } }
    const allBorders = { top: border, left: border, bottom: border, right: border }

    const wb = new ExcelJS.Workbook()
    const sheetName = (program.name || 'Program').replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Program'
    const ws = wb.addWorksheet(sheetName)

    ws.getColumn(1).width = 13
    for (let weekIndex = 0; weekIndex < numWeeks; weekIndex++) {
      const col = weekColumnStart(weekIndex)
      exportColumns.forEach((c, i) => { ws.getColumn(col + i).width = c.width })
      if (weekIndex < numWeeks - 1) ws.getColumn(col + exportColumnCount).width = 3
    }

    let row = 1
    for (let weekIndex = 0; weekIndex < numWeeks; weekIndex++) {
      const col = weekColumnStart(weekIndex)
      const cell = ws.getCell(row, col)
      cell.value = `Week ${weekIndex + 1}`
      cell.fill = fill(RED)
      cell.font = { bold: true, italic: true, color: { argb: 'FFFFFFFF' } }
      cell.alignment = { horizontal: 'center', vertical: 'middle' }
      cell.border = allBorders
      if (exportColumnCount > 1) ws.mergeCells(row, col, row, col + exportColumnCount - 1)
    }
    row++

    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
      const { perWeek, maxRows } = dayData[dayOfWeek]

      const dayCell = ws.getCell(row, 1)
      dayCell.value = DAY_NAMES[dayOfWeek]
      dayCell.fill = fill(RED)
      dayCell.font = { bold: true, italic: true, color: { argb: 'FFFFFFFF' } }
      dayCell.alignment = { horizontal: 'left', vertical: 'middle' }
      dayCell.border = allBorders
      for (let weekIndex = 0; weekIndex < numWeeks; weekIndex++) {
        const col = weekColumnStart(weekIndex)
        exportColumns.forEach((c, i) => {
          const cell = ws.getCell(row, col + i)
          cell.value = c.label
          cell.fill = fill(c.color)
          cell.font = { bold: true, italic: true }
          cell.alignment = { horizontal: 'left', vertical: 'middle' }
          cell.border = allBorders
        })
      }
      row++

      const bodyCount = Math.max(maxRows, 1)
      for (let r = 0; r < bodyCount; r++) {
        if (r === 0) {
          const noteCell = ws.getCell(row, 1)
          noteCell.value = 'notes:'
          noteCell.font = { italic: true, color: { argb: 'FF888888' } }
        }
        for (let weekIndex = 0; weekIndex < numWeeks; weekIndex++) {
          const exercise = perWeek[weekIndex][r]
          if (!exercise) continue
          const prevExercise = r > 0 ? perWeek[weekIndex][r - 1] : null
          const isSubSet = !!(prevExercise && exercise.group_id && exercise.group_id === prevExercise.group_id)
          const col = weekColumnStart(weekIndex)
          exportColumns.forEach((c, i) => {
            const cell = ws.getCell(row, col + i)
            cell.value = isSubSet && c.key === 'name' ? '' : c.get(exercise)
            if (c.key === 'name' && !isSubSet) cell.font = { bold: true }
          })
        }
        for (let c = 1; c <= totalCols; c++) {
          const offset = c - fixedColumnCount - 1
          const isGap = c > fixedColumnCount && offset >= 0 && (offset % (exportColumnCount + 1)) === exportColumnCount
          if (isGap) continue
          const cell = ws.getCell(row, c)
          cell.border = allBorders
          if (c >= fixedColumnCount + 1) {
            const exportCol = exportColumns[offset % (exportColumnCount + 1)]
            cell.alignment = { horizontal: exportCol?.key === 'name' ? 'left' : 'center', vertical: 'middle' }
          }
        }
        row++
      }
      row++
    }

    const buffer = await wb.xlsx.writeBuffer()
    const safeName = (program.name || 'program').replace(/[^\w\s-]/g, '_').replace(/\s+/g, '_').slice(0, 60) || 'program'
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.xlsx"`)
    res.send(Buffer.from(buffer as ArrayBuffer))
  } catch {
    res.status(500).json({ error: 'Failed to export program' })
  }
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

      const preview = await parseExternalFile(buffer)

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

      const result = await commitExternalProgram(preview.exercises, {
        athleteId: meta.athlete_id,
        name: meta.name,
        status: meta.status,
        startDate: meta.start_date ?? undefined,
        weeks: preview.weeks,
        focus: meta.focus ?? null,
      })
      res.status(201).json(result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'External import failed'
      res.status(msg.includes('not found') ? 400 : 500).json({ error: msg })
    }
  },
)

export default router
