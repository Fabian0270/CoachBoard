import { Router, Request, Response } from 'express'
import ExcelJS from 'exceljs'
import { v4 as uuidv4 } from 'uuid'
import { db, toIsoDate } from './db-proxy.js'

const router = Router()

const TOGGLEABLE_COLUMNS = ['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe'] as const
type ToggleableColumn = typeof TOGGLEABLE_COLUMNS[number]

function serializeEnabledColumns(input: unknown): string | null {
  if (input === null || input === undefined) return null
  if (!Array.isArray(input)) return null
  const filtered = input.filter((c): c is ToggleableColumn => typeof c === 'string' && (TOGGLEABLE_COLUMNS as readonly string[]).includes(c))
  return JSON.stringify(filtered)
}

function withParsedColumns<T extends { enabled_columns: string | null }>(program: T): T & { enabled_columns: ToggleableColumn[] | null } {
  if (!program.enabled_columns) return { ...program, enabled_columns: null }
  try {
    const parsed = JSON.parse(program.enabled_columns)
    if (!Array.isArray(parsed)) return { ...program, enabled_columns: null }
    return { ...program, enabled_columns: parsed.filter((c): c is ToggleableColumn => (TOGGLEABLE_COLUMNS as readonly string[]).includes(c)) }
  } catch {
    return { ...program, enabled_columns: null }
  }
}

function mondayOf(date: Date): Date {
  const dayOfWeek = date.getUTCDay()
  const offset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
  const monday = new Date(date)
  monday.setUTCDate(date.getUTCDate() + offset)
  return monday
}

router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    let query = db.selectFrom('programs').selectAll()
    if (req.query.athlete_id) {
      query = query.where('athlete_id', '=', req.query.athlete_id as string)
    }
    const programs = await query.orderBy('created_at', 'desc').execute()
    res.json(programs.map(withParsedColumns))
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch programs' })
  }
})

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const program = await db
      .selectFrom('programs')
      .selectAll()
      .where('id', '=', req.params.id)
      .executeTakeFirst()
    if (!program) {
      res.status(404).json({ error: 'Program not found' })
      return
    }
    const workouts = await db
      .selectFrom('workouts')
      .selectAll()
      .where('program_id', '=', req.params.id)
      .orderBy('scheduled_date')
      .execute()
    const workoutIds = workouts.map((workout) => workout.id)
    const exercises = workoutIds.length
      ? await db.selectFrom('exercises').selectAll().where('workout_id', 'in', workoutIds).orderBy('order_index').execute()
      : []
    res.json({ ...withParsedColumns(program), workouts: workouts.map((workout) => ({ ...workout, exercises: exercises.filter((e) => e.workout_id === workout.id) })) })
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch program' })
  }
})

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { athlete_id, name, description, start_date, end_date, status, enabled_columns } = req.body
  if (!athlete_id || !name) {
    res.status(400).json({ error: 'athlete_id and name are required' })
    return
  }
  try {
    const now = new Date().toISOString()
    const program = await db
      .insertInto('programs')
      .values({
        id: uuidv4(),
        athlete_id,
        name,
        description: description ?? null,
        start_date: start_date ?? null,
        end_date: end_date ?? null,
        status: status ?? 'active',
        enabled_columns: serializeEnabledColumns(enabled_columns),
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    res.status(201).json(withParsedColumns(program))
  } catch (err) {
    res.status(500).json({ error: 'Failed to create program' })
  }
})

router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  const { name, description, start_date, end_date, status, enabled_columns } = req.body
  try {
    const updated = await db
      .updateTable('programs')
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description: description ?? null } : {}),
        ...(start_date !== undefined ? { start_date: start_date ?? null } : {}),
        ...(end_date !== undefined ? { end_date: end_date ?? null } : {}),
        ...(status !== undefined ? { status: status ?? 'active' } : {}),
        ...(enabled_columns !== undefined ? { enabled_columns: serializeEnabledColumns(enabled_columns) } : {}),
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', req.params.id)
      .returningAll()
      .executeTakeFirst()
    if (!updated) {
      res.status(404).json({ error: 'Program not found' })
      return
    }
    res.json(withParsedColumns(updated))
  } catch (err) {
    res.status(500).json({ error: 'Failed to update program' })
  }
})

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await db
      .deleteFrom('programs')
      .where('id', '=', req.params.id)
      .returningAll()
      .executeTakeFirst()
    if (!deleted) {
      res.status(404).json({ error: 'Program not found' })
      return
    }
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete program' })
  }
})

router.post('/:programId/workouts', async (req: Request, res: Response): Promise<void> => {
  const { name, scheduled_date, notes } = req.body
  const resolvedName = name || scheduled_date || 'Workout'
  try {
    const workout = await db
      .insertInto('workouts')
      .values({
        id: uuidv4(),
        program_id: req.params.programId,
        name: resolvedName,
        scheduled_date: scheduled_date ?? null,
        notes: notes ?? null,
        created_at: new Date().toISOString(),
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    res.status(201).json(workout)
  } catch (err) {
    res.status(500).json({ error: 'Failed to create workout' })
  }
})

router.put('/:programId/workouts/:workoutId', async (req: Request, res: Response): Promise<void> => {
  const { name, scheduled_date, notes } = req.body
  try {
    const updated = await db
      .updateTable('workouts')
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(scheduled_date !== undefined ? { scheduled_date: scheduled_date ?? null } : {}),
        ...(notes !== undefined ? { notes: notes ?? null } : {}),
      })
      .where('id', '=', req.params.workoutId)
      .where('program_id', '=', req.params.programId)
      .returningAll()
      .executeTakeFirst()
    if (!updated) {
      res.status(404).json({ error: 'Workout not found' })
      return
    }
    res.json(updated)
  } catch (err) {
    res.status(500).json({ error: 'Failed to update workout' })
  }
})

router.delete('/:programId/workouts/:workoutId', async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await db
      .deleteFrom('workouts')
      .where('id', '=', req.params.workoutId)
      .where('program_id', '=', req.params.programId)
      .returningAll()
      .executeTakeFirst()
    if (!deleted) {
      res.status(404).json({ error: 'Workout not found' })
      return
    }
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete workout' })
  }
})

router.get('/:id/export', async (req: Request, res: Response): Promise<void> => {
  try {
    const program = await db.selectFrom('programs').selectAll().where('id', '=', req.params.id).executeTakeFirst()
    if (!program) {
      res.status(404).json({ error: 'Program not found' })
      return
    }
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

    const workouts = await db.selectFrom('workouts').selectAll().where('program_id', '=', program.id).execute()
    const workoutIds = workouts.map((workout) => workout.id)
    const exercises = workoutIds.length
      ? await db.selectFrom('exercises').selectAll().where('workout_id', 'in', workoutIds).orderBy('order_index').execute()
      : []

    const exercisesByWorkout = new Map<string, typeof exercises>()
    for (const exercise of exercises) {
      const list = exercisesByWorkout.get(exercise.workout_id) ?? []
      list.push(exercise)
      exercisesByWorkout.set(exercise.workout_id, list)
    }
    const workoutByDate = new Map<string, typeof workouts[number]>()
    for (const workout of workouts) {
      if (workout.scheduled_date) workoutByDate.set(workout.scheduled_date, workout)
    }

    const [sy, sm, sd] = program.start_date.split('-').map(Number)
    const [ey, em, ed] = program.end_date.split('-').map(Number)
    const rawStart = new Date(Date.UTC(sy, sm - 1, sd))
    const startMonday = mondayOf(rawStart)
    const endDate = new Date(Date.UTC(ey, em - 1, ed))
    const totalDays = Math.round((endDate.getTime() - startMonday.getTime()) / 86400000) + 1
    const numWeeks = Math.max(1, Math.ceil(totalDays / 7))

    type ExerciseRow = typeof exercises[number]

    const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    const dayData: Array<{ perWeek: ExerciseRow[][]; maxRows: number }> = []
    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
      const perWeek: ExerciseRow[][] = []
      let maxRows = 0
      for (let weekIndex = 0; weekIndex < numWeeks; weekIndex++) {
        const date = new Date(startMonday)
        date.setUTCDate(startMonday.getUTCDate() + weekIndex * 7 + dayOfWeek)
        const workout = workoutByDate.get(toIsoDate(date))
        const workoutExercises = workout ? exercisesByWorkout.get(workout.id) ?? [] : []
        perWeek.push(workoutExercises)
        if (workoutExercises.length > maxRows) maxRows = workoutExercises.length
      }
      dayData.push({ perWeek, maxRows })
    }

    type ExportColumn = { key: string; label: string; color: string; width: number; get: (ex: ExerciseRow) => string | number | null }
    const HEADER_COLOR = 'FFB39DDB'
    const TRACKING_COLOR = 'FF4DB6AC'
    const exportColumns: ExportColumn[] = []
    exportColumns.push({ key: 'name', label: 'Discipline', color: HEADER_COLOR, width: 22, get: (ex) => ex.name ?? '' })
    if (isEnabled('rest_time')) exportColumns.push({ key: 'rest_time', label: 'Rest Time(mins)', color: HEADER_COLOR, width: 12, get: (ex) => ex.rest_time ?? '' })
    exportColumns.push({ key: 'sets', label: 'Sets', color: HEADER_COLOR, width: 6, get: (ex) => ex.sets ?? '' })
    exportColumns.push({ key: 'reps', label: 'Reps', color: HEADER_COLOR, width: 6, get: (ex) => ex.reps ?? '' })
    if (isEnabled('intensity')) exportColumns.push({ key: 'intensity', label: 'Intensity/Weight', color: HEADER_COLOR, width: 16, get: (ex) => ex.intensity ?? '' })
    if (isEnabled('load_cap')) exportColumns.push({ key: 'load_cap', label: 'Load Cap', color: TRACKING_COLOR, width: 10, get: (ex) => ex.weight ?? '' })
    if (isEnabled('load_used')) exportColumns.push({ key: 'load_used', label: 'Load Used', color: TRACKING_COLOR, width: 10, get: (ex) => ex.load_used ?? '' })
    if (isEnabled('rpe')) exportColumns.push({ key: 'rpe', label: 'Last Set RPE', color: TRACKING_COLOR, width: 13, get: (ex) => ex.rpe ?? '' })

    const fixedColumnCount = 1 // Day column
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
      exportColumns.forEach((exportCol, i) => {
        ws.getColumn(col + i).width = exportCol.width
      })
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
      if (exportColumnCount > 1) {
        ws.mergeCells(row, col, row, col + exportColumnCount - 1)
      }
    }
    row++

    const writeDayHeader = (rowIndex: number, dayOfWeek: number) => {
      const dayCell = ws.getCell(rowIndex, 1)
      dayCell.value = DAY_NAMES[dayOfWeek]
      dayCell.fill = fill(RED)
      dayCell.font = { bold: true, italic: true, color: { argb: 'FFFFFFFF' } }
      dayCell.alignment = { horizontal: 'left', vertical: 'middle' }
      dayCell.border = allBorders

      for (let weekIndex = 0; weekIndex < numWeeks; weekIndex++) {
        const col = weekColumnStart(weekIndex)
        exportColumns.forEach((exportCol, i) => {
          const cell = ws.getCell(rowIndex, col + i)
          cell.value = exportCol.label
          cell.fill = fill(exportCol.color)
          cell.font = { bold: true, italic: true }
          cell.alignment = { horizontal: 'left', vertical: 'middle' }
          cell.border = allBorders
        })
      }
    }

    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
      const { perWeek, maxRows } = dayData[dayOfWeek]
      writeDayHeader(row, dayOfWeek)
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
          const col = weekColumnStart(weekIndex)
          exportColumns.forEach((exportCol, i) => {
            const cell = ws.getCell(row, col + i)
            cell.value = exportCol.get(exercise)
            if (exportCol.key === 'name') cell.font = { bold: true }
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
  } catch (err) {
    res.status(500).json({ error: 'Failed to export program' })
  }
})

router.put('/:programId/duration', async (req: Request, res: Response): Promise<void> => {
  const { start_date, weeks } = req.body
  if (!start_date || !weeks || weeks < 1) {
    res.status(400).json({ error: 'start_date and weeks (>=1) are required' })
    return
  }
  const start = new Date(start_date)
  if (isNaN(start.getTime())) {
    res.status(400).json({ error: 'invalid start_date' })
    return
  }
  try {
    const monday = mondayOf(start)
    const end = new Date(monday)
    end.setUTCDate(monday.getUTCDate() + Number(weeks) * 7 - 1)
    const updated = await db
      .updateTable('programs')
      .set({
        start_date: toIsoDate(monday),
        end_date: toIsoDate(end),
        updated_at: new Date().toISOString(),
      })
      .where('id', '=', req.params.programId)
      .returningAll()
      .executeTakeFirst()
    if (!updated) {
      res.status(404).json({ error: 'Program not found' })
      return
    }
    res.json(updated)
  } catch (err) {
    res.status(500).json({ error: 'Failed to update program duration' })
  }
})

router.post('/:programId/workouts/:workoutId/exercises', async (req: Request, res: Response): Promise<void> => {
  const { name, sets, reps, weight, duration, distance, notes, order_index, rest_time, intensity, load_used, rpe } = req.body
  try {
    const exercise = await db
      .insertInto('exercises')
      .values({
        id: uuidv4(),
        workout_id: req.params.workoutId,
        name: name ?? '',
        sets: sets ?? null,
        reps: reps ?? null,
        weight: weight ?? null,
        duration: duration ?? null,
        distance: distance ?? null,
        notes: notes ?? null,
        order_index: order_index ?? 0,
        rest_time: rest_time ?? null,
        intensity: intensity ?? null,
        load_used: load_used ?? null,
        rpe: rpe ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
    res.status(201).json(exercise)
  } catch (err) {
    res.status(500).json({ error: 'Failed to create exercise' })
  }
})

router.put('/:programId/workouts/:workoutId/exercises/:exerciseId', async (req: Request, res: Response): Promise<void> => {
  const { name, sets, reps, weight, duration, distance, notes, order_index, rest_time, intensity, load_used, rpe } = req.body
  try {
    const updated = await db
      .updateTable('exercises')
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(sets !== undefined ? { sets: sets ?? null } : {}),
        ...(reps !== undefined ? { reps: reps ?? null } : {}),
        ...(weight !== undefined ? { weight: weight ?? null } : {}),
        ...(duration !== undefined ? { duration: duration ?? null } : {}),
        ...(distance !== undefined ? { distance: distance ?? null } : {}),
        ...(notes !== undefined ? { notes: notes ?? null } : {}),
        ...(order_index !== undefined ? { order_index } : {}),
        ...(rest_time !== undefined ? { rest_time: rest_time ?? null } : {}),
        ...(intensity !== undefined ? { intensity: intensity ?? null } : {}),
        ...(load_used !== undefined ? { load_used: load_used ?? null } : {}),
        ...(rpe !== undefined ? { rpe: rpe ?? null } : {}),
      })
      .where('id', '=', req.params.exerciseId)
      .where('workout_id', '=', req.params.workoutId)
      .returningAll()
      .executeTakeFirst()
    if (!updated) {
      res.status(404).json({ error: 'Exercise not found' })
      return
    }
    res.json(updated)
  } catch (err) {
    res.status(500).json({ error: 'Failed to update exercise' })
  }
})

router.delete('/:programId/workouts/:workoutId/exercises/:exerciseId', async (req: Request, res: Response): Promise<void> => {
  try {
    const deleted = await db
      .deleteFrom('exercises')
      .where('id', '=', req.params.exerciseId)
      .where('workout_id', '=', req.params.workoutId)
      .returningAll()
      .executeTakeFirst()
    if (!deleted) {
      res.status(404).json({ error: 'Exercise not found' })
      return
    }
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete exercise' })
  }
})

export default router
