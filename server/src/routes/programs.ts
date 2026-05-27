import { Router, Request, Response } from 'express'
import ExcelJS from 'exceljs'
import { db } from '../db.js'
import { v4 as uuidv4 } from 'uuid'

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

router.get('/', async (req: Request, res: Response): Promise<void> => {
  let query = db.selectFrom('programs').selectAll()
  if (req.query.athlete_id) {
    query = query.where('athlete_id', '=', req.query.athlete_id as string)
  }
  const programs = await query.orderBy('created_at', 'desc').execute()
  res.json(programs.map(withParsedColumns))
})

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
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
  const workoutIds = workouts.map((w) => w.id)
  const exercises = workoutIds.length
    ? await db.selectFrom('exercises').selectAll().where('workout_id', 'in', workoutIds).orderBy('order_index').execute()
    : []
  res.json({ ...withParsedColumns(program), workouts: workouts.map((w) => ({ ...w, exercises: exercises.filter((e) => e.workout_id === w.id) })) })
})

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { athlete_id, name, description, start_date, end_date, status, enabled_columns } = req.body
  if (!athlete_id || !name) {
    res.status(400).json({ error: 'athlete_id and name are required' })
    return
  }
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
})

router.put('/:id', async (req: Request, res: Response): Promise<void> => {
  const { name, description, start_date, end_date, status, enabled_columns } = req.body
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
})

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
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
})

router.post<{ programId: string }>('/:programId/workouts', async (req, res): Promise<void> => {
  const { name, scheduled_date, notes } = req.body
  const resolvedName = name || scheduled_date || 'Workout'
  const workout = await db
    .insertInto('workouts')
    .values({ id: uuidv4(), program_id: req.params.programId, name: resolvedName, scheduled_date: scheduled_date ?? null, notes: notes ?? null, created_at: new Date().toISOString() })
    .returningAll()
    .executeTakeFirstOrThrow()
  res.status(201).json(workout)
})

router.put('/:programId/workouts/:workoutId', async (req: Request, res: Response): Promise<void> => {
  const { name, scheduled_date, notes } = req.body
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
})

router.delete('/:programId/workouts/:workoutId', async (req: Request, res: Response): Promise<void> => {
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
})

router.get<{ id: string }>('/:id/export', async (req, res): Promise<void> => {
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
  const workoutIds = workouts.map((w) => w.id)
  const exercises = workoutIds.length
    ? await db.selectFrom('exercises').selectAll().where('workout_id', 'in', workoutIds).orderBy('order_index').execute()
    : []

  const exercisesByWorkout = new Map<string, typeof exercises>()
  for (const ex of exercises) {
    const list = exercisesByWorkout.get(ex.workout_id) ?? []
    list.push(ex)
    exercisesByWorkout.set(ex.workout_id, list)
  }
  const workoutByDate = new Map<string, typeof workouts[number]>()
  for (const w of workouts) if (w.scheduled_date) workoutByDate.set(w.scheduled_date, w)

  const [sy, sm, sd] = program.start_date.split('-').map(Number)
  const [ey, em, ed] = program.end_date.split('-').map(Number)
  const startMonday = new Date(Date.UTC(sy, sm - 1, sd))
  const endDate = new Date(Date.UTC(ey, em - 1, ed))
  const totalDays = Math.round((endDate.getTime() - startMonday.getTime()) / 86400000) + 1
  const numWeeks = Math.max(1, Math.ceil(totalDays / 7))
  const isoDate = (d: Date) => d.toISOString().slice(0, 10)

  type Ex = typeof exercises[number]
  interface DayRow { name: string; restTime: string; perWeek: Array<Ex | null> }

  const DOW_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  const dayData: DayRow[][] = []
  for (let dow = 0; dow < 7; dow++) {
    const rowsByKey = new Map<string, DayRow>()
    const orderedKeys: string[] = []
    for (let w = 0; w < numWeeks; w++) {
      const date = new Date(startMonday)
      date.setUTCDate(startMonday.getUTCDate() + w * 7 + dow)
      const workout = workoutByDate.get(isoDate(date))
      if (!workout) continue
      const exes = exercisesByWorkout.get(workout.id) ?? []
      for (const ex of exes) {
        const rawName = (ex.name ?? '').trim()
        const key = rawName.toLowerCase() || `__unnamed_${ex.id}`
        let row = rowsByKey.get(key)
        if (!row) {
          row = { name: rawName, restTime: ex.rest_time ?? '', perWeek: Array<Ex | null>(numWeeks).fill(null) }
          rowsByKey.set(key, row)
          orderedKeys.push(key)
        }
        if (!row.restTime && ex.rest_time) row.restTime = ex.rest_time
        row.perWeek[w] = ex
      }
    }
    dayData.push(orderedKeys.map((k) => rowsByKey.get(k)!))
  }

  type PerWeekCol = { key: string; label: string; color: string; get: (ex: Ex) => string | number | null }
  const PURPLE = 'FFB39DDB'
  const GREEN = 'FF4DB6AC'
  const allPerWeekCols: PerWeekCol[] = [
    { key: 'sets', label: 'Sets', color: PURPLE, get: (ex) => ex.sets ?? '' },
    { key: 'reps', label: 'Reps', color: PURPLE, get: (ex) => ex.reps ?? '' },
    { key: 'intensity', label: 'Intensity/Weight', color: PURPLE, get: (ex) => ex.intensity ?? '' },
    { key: 'load_cap', label: 'Load Cap', color: GREEN, get: (ex) => ex.weight ?? '' },
    { key: 'load_used', label: 'Load Used', color: GREEN, get: (ex) => ex.load_used ?? '' },
    { key: 'rpe', label: 'Last Set RPE', color: GREEN, get: (ex) => ex.rpe ?? '' },
  ]
  const perWeekCols = allPerWeekCols.filter((c) => c.key === 'sets' || c.key === 'reps' || isEnabled(c.key as ToggleableColumn))
  const showRestTime = isEnabled('rest_time')

  const fixedColCount = 2 + (showRestTime ? 1 : 0) // Day, Discipline, [Rest Time]
  const perWeekColCount = perWeekCols.length
  const weekColStart = (w: number) => fixedColCount + 1 + w * (perWeekColCount + 1)
  const totalCols = fixedColCount + numWeeks * perWeekColCount + (numWeeks - 1)

  const RED = 'FFE57373'
  const BORDER_COLOR = 'FFCCCCCC'
  const fill = (argb: string): ExcelJS.FillPattern => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } })
  const border: ExcelJS.Border = { style: 'thin', color: { argb: BORDER_COLOR } }
  const allBorders = { top: border, left: border, bottom: border, right: border }

  const wb = new ExcelJS.Workbook()
  const sheetName = (program.name || 'Program').replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Program'
  const ws = wb.addWorksheet(sheetName)

  ws.getColumn(1).width = 13
  ws.getColumn(2).width = 26
  if (showRestTime) ws.getColumn(3).width = 14
  const colWidthByKey: Record<string, number> = { sets: 6, reps: 6, intensity: 16, load_cap: 10, load_used: 10, rpe: 13 }
  for (let w = 0; w < numWeeks; w++) {
    const c = weekColStart(w)
    perWeekCols.forEach((pc, i) => {
      ws.getColumn(c + i).width = colWidthByKey[pc.key] ?? 10
    })
    if (w < numWeeks - 1) ws.getColumn(c + perWeekColCount).width = 3
  }

  let row = 1
  for (let w = 0; w < numWeeks; w++) {
    const cell = ws.getCell(row, weekColStart(w))
    cell.value = `Week ${w + 1}`
    cell.fill = fill(RED)
    cell.font = { bold: true, italic: true, color: { argb: 'FFFFFFFF' } }
    cell.alignment = { horizontal: 'center', vertical: 'middle' }
    cell.border = allBorders
  }
  row++

  const writeDayHeader = (r: number, dow: number) => {
    const dayCell = ws.getCell(r, 1)
    dayCell.value = DOW_NAMES[dow]
    dayCell.fill = fill(RED)
    dayCell.font = { bold: true, italic: true, color: { argb: 'FFFFFFFF' } }
    dayCell.alignment = { horizontal: 'left', vertical: 'middle' }
    dayCell.border = allBorders

    const discCell = ws.getCell(r, 2)
    discCell.value = 'Discipline'
    discCell.fill = fill(PURPLE)
    discCell.font = { bold: true, italic: true }
    discCell.alignment = { horizontal: 'left', vertical: 'middle' }
    discCell.border = allBorders

    if (showRestTime) {
      const restCell = ws.getCell(r, 3)
      restCell.value = 'Rest Time(mins)'
      restCell.fill = fill(PURPLE)
      restCell.font = { bold: true, italic: true }
      restCell.alignment = { horizontal: 'left', vertical: 'middle' }
      restCell.border = allBorders
    }

    for (let w = 0; w < numWeeks; w++) {
      const c = weekColStart(w)
      perWeekCols.forEach((pc, i) => {
        const cell = ws.getCell(r, c + i)
        cell.value = pc.label
        cell.fill = fill(pc.color)
        cell.font = { bold: true, italic: true }
        cell.alignment = { horizontal: 'left', vertical: 'middle' }
        cell.border = allBorders
      })
    }
  }

  for (let dow = 0; dow < 7; dow++) {
    const rows = dayData[dow]
    writeDayHeader(row, dow)
    row++

    const bodyCount = Math.max(rows.length, 1)
    for (let r = 0; r < bodyCount; r++) {
      const data = rows[r]
      if (r === 0) {
        const noteCell = ws.getCell(row, 1)
        noteCell.value = 'notes:'
        noteCell.font = { italic: true, color: { argb: 'FF888888' } }
      }
      if (data) {
        const nameCell = ws.getCell(row, 2)
        nameCell.value = data.name
        nameCell.font = { bold: true }
        if (showRestTime) ws.getCell(row, 3).value = data.restTime
        for (let w = 0; w < numWeeks; w++) {
          const ex = data.perWeek[w]
          if (!ex) continue
          const c = weekColStart(w)
          perWeekCols.forEach((pc, i) => {
            ws.getCell(row, c + i).value = pc.get(ex)
          })
        }
      }
      for (let c = 1; c <= totalCols; c++) {
        const offset = c - fixedColCount - 1
        const isGap = c > fixedColCount && offset >= 0 && (offset % (perWeekColCount + 1)) === perWeekColCount
        if (isGap) continue
        const cell = ws.getCell(row, c)
        cell.border = allBorders
        if (c >= fixedColCount + 1) cell.alignment = { horizontal: 'center', vertical: 'middle' }
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
  const day = start.getUTCDay()
  const offset = day === 0 ? -6 : 1 - day
  const monday = new Date(start)
  monday.setUTCDate(start.getUTCDate() + offset)
  const end = new Date(monday)
  end.setUTCDate(monday.getUTCDate() + Number(weeks) * 7 - 1)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const updated = await db
    .updateTable('programs')
    .set({
      start_date: iso(monday),
      end_date: iso(end),
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
})

router.post<{ programId: string; workoutId: string }>('/:programId/workouts/:workoutId/exercises', async (req, res): Promise<void> => {
  const { name, sets, reps, weight, duration, distance, notes, order_index, rest_time, intensity, load_used, rpe } = req.body
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
})

router.put('/:programId/workouts/:workoutId/exercises/:exerciseId', async (req: Request, res: Response): Promise<void> => {
  const { name, sets, reps, weight, duration, distance, notes, order_index, rest_time, intensity, load_used, rpe } = req.body
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
})

router.delete('/:programId/workouts/:workoutId/exercises/:exerciseId', async (req: Request, res: Response): Promise<void> => {
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
})

export default router
