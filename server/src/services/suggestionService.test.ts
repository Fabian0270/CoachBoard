import { beforeAll, describe, it, expect } from 'vitest'
import { initializeDatabase, getDb } from '../db.js'
import { createAthlete } from './athleteService.js'
import { createProgram, createWorkout, createExercise, updateProgram } from './programService.js'
import { generateDraftProgram } from './suggestionService.js'

let athleteId: string
let completedProgramId: string

beforeAll(async () => {
  await initializeDatabase(':memory:')

  const athlete = await createAthlete({ name: 'Test Lifter' })
  athleteId = athlete.id

  // Store an athlete max so e1RM fallback is testable
  await getDb()
    .insertInto('athlete_maxes')
    .values({
      id: 'max-squat',
      athlete_id: athleteId,
      lift_name: 'Squat',
      weight: 180,
      unit: 'kg',
      recorded_at: '2026-01-01',
      notes: null,
    })
    .execute()

  // Create a completed 4-week program with load_used + rpe filled in
  const program = await createProgram({
    athlete_id: athleteId,
    name: 'Test Block',
    start_date: '2026-01-06',  // Monday
    status: 'active',
  })
  completedProgramId = program.id

  // Week 4 (last week) — 3-day split: Mon squat, Wed bench, Fri deadlift
  const days = [
    { date: '2026-01-27', lift: 'Squat',      loadUsed: '145', rpe: '8', accessories: ['Leg Press', 'Leg Curl'] },
    { date: '2026-01-29', lift: 'Bench Press', loadUsed: '95',  rpe: '8', accessories: ['Tricep Pushdown'] },
    { date: '2026-01-31', lift: 'Deadlift',   loadUsed: '180', rpe: '8', accessories: ['RDL'] },
  ]

  for (const day of days) {
    const workout = await createWorkout({ program_id: completedProgramId, name: day.date, scheduled_date: day.date })
    // Main lift with filled results
    await createExercise({
      workout_id: workout.id,
      name: day.lift,
      sets: '4',
      reps: '5',
      weight: parseFloat(day.loadUsed),
      intensity: 'RPE 8',
      load_used: day.loadUsed,
      rpe: day.rpe,
      order_index: 0,
    })
    // Accessories (no results)
    for (let i = 0; i < day.accessories.length; i++) {
      await createExercise({
        workout_id: workout.id,
        name: day.accessories[i],
        sets: '3',
        reps: '10',
        order_index: i + 1,
      })
    }
  }

  await updateProgram(completedProgramId, { status: 'completed' })
})

describe('generateDraftProgram', () => {
  it('creates a draft program with correct status', async () => {
    const result = await generateDraftProgram(completedProgramId, {
      athleteId,
      templateId: 'strength_linear',
      weeks: 4,
      trainingDaysPerWeek: 3,
      startDate: '2026-02-02',
    })

    const draft = await getDb()
      .selectFrom('programs')
      .selectAll()
      .where('id', '=', result.draftProgramId)
      .executeTakeFirstOrThrow()

    expect(draft.status).toBe('draft')
    expect(draft.athlete_id).toBe(athleteId)
    expect(draft.name).toContain('[Draft]')
  })

  it('creates correct number of workouts (weeks × days)', async () => {
    const result = await generateDraftProgram(completedProgramId, {
      athleteId,
      templateId: 'strength_linear',
      weeks: 4,
      trainingDaysPerWeek: 3,
      startDate: '2026-02-09',
    })

    const workouts = await getDb()
      .selectFrom('workouts')
      .selectAll()
      .where('program_id', '=', result.draftProgramId)
      .execute()

    expect(workouts).toHaveLength(4 * 3)
  })

  it('main lift exercises have suggestion_note set', async () => {
    const result = await generateDraftProgram(completedProgramId, {
      athleteId,
      templateId: 'strength_linear',
      weeks: 4,
      trainingDaysPerWeek: 3,
      startDate: '2026-02-16',
    })

    const exercises = await getDb()
      .selectFrom('exercises')
      .innerJoin('workouts', 'workouts.id', 'exercises.workout_id')
      .select(['exercises.name', 'exercises.suggestion_note'])
      .where('workouts.program_id', '=', result.draftProgramId)
      .execute()

    const mainLifts = exercises.filter((e) =>
      ['Squat', 'Bench Press', 'Deadlift'].includes(e.name),
    )
    expect(mainLifts.length).toBeGreaterThan(0)
    mainLifts.forEach((e) => expect(e.suggestion_note).not.toBeNull())
  })

  it('accessory exercises have load_used null and suggestion_note null', async () => {
    const result = await generateDraftProgram(completedProgramId, {
      athleteId,
      templateId: 'strength_linear',
      weeks: 4,
      trainingDaysPerWeek: 3,
      startDate: '2026-02-23',
    })

    const exercises = await getDb()
      .selectFrom('exercises')
      .innerJoin('workouts', 'workouts.id', 'exercises.workout_id')
      .selectAll('exercises')
      .where('workouts.program_id', '=', result.draftProgramId)
      .execute()

    const accessories = exercises.filter(
      (e) => !['Squat', 'Bench Press', 'Deadlift'].includes(e.name),
    )
    accessories.forEach((e) => {
      expect(e.load_used).toBeNull()
      expect(e.suggestion_note).toBeNull()
    })
  })

  it('main lift intensity field uses RPE format', async () => {
    const result = await generateDraftProgram(completedProgramId, {
      athleteId,
      templateId: 'strength_linear',
      weeks: 4,
      trainingDaysPerWeek: 3,
      startDate: '2026-03-02',
    })

    const exercises = await getDb()
      .selectFrom('exercises')
      .innerJoin('workouts', 'workouts.id', 'exercises.workout_id')
      .select(['exercises.name', 'exercises.intensity'])
      .where('workouts.program_id', '=', result.draftProgramId)
      .execute()

    const mainLifts = exercises.filter((e) =>
      ['Squat', 'Bench Press', 'Deadlift'].includes(e.name),
    )
    mainLifts.forEach((e) => {
      expect(e.intensity).toMatch(/^RPE \d+(\.\d+)?$/)
    })
  })

  it('start_date and end_date are set correctly', async () => {
    const result = await generateDraftProgram(completedProgramId, {
      athleteId,
      templateId: 'strength_linear',
      weeks: 6,
      trainingDaysPerWeek: 3,
      startDate: '2026-03-09',
    })

    const draft = await getDb()
      .selectFrom('programs')
      .select(['start_date', 'end_date'])
      .where('id', '=', result.draftProgramId)
      .executeTakeFirstOrThrow()

    expect(draft.start_date).toBe('2026-03-09')
    expect(draft.end_date).toBe('2026-04-19')  // 6 weeks - 1 day = 41 days later
  })

  it('throws when source program does not exist', async () => {
    await expect(
      generateDraftProgram('00000000-0000-0000-0000-000000000000', {
        athleteId,
        templateId: 'strength_linear',
        weeks: 4,
        trainingDaysPerWeek: 3,
        startDate: '2026-03-16',
      }),
    ).rejects.toThrow('not found')
  })

  it('throws when source program is not completed', async () => {
    const active = await createProgram({ athlete_id: athleteId, name: 'Active', status: 'active' })
    await expect(
      generateDraftProgram(active.id, {
        athleteId,
        templateId: 'strength_linear',
        weeks: 4,
        trainingDaysPerWeek: 3,
        startDate: '2026-03-16',
      }),
    ).rejects.toThrow('not completed')
  })

  it('throws when templateId is unknown', async () => {
    await expect(
      generateDraftProgram(completedProgramId, {
        athleteId,
        templateId: 'bogus_template',
        weeks: 4,
        trainingDaysPerWeek: 3,
        startDate: '2026-03-16',
      }),
    ).rejects.toThrow('Unknown template')
  })

  it('uses athlete_maxes fallback when no e1RM from report', async () => {
    // A completed program with NO load_used data — report gives no e1RM
    const emptyProgram = await createProgram({
      athlete_id: athleteId,
      name: 'Empty Block',
      start_date: '2026-03-02',
      status: 'active',
    })
    const workout = await createWorkout({
      program_id: emptyProgram.id,
      name: '2026-03-03',
      scheduled_date: '2026-03-03',
    })
    await createExercise({ workout_id: workout.id, name: 'Squat', sets: '4', reps: '5', order_index: 0 })
    await updateProgram(emptyProgram.id, { status: 'completed' })

    // Should still generate — uses athlete_maxes (180 kg squat stored in beforeAll)
    const result = await generateDraftProgram(emptyProgram.id, {
      athleteId,
      templateId: 'strength_linear',
      weeks: 4,
      trainingDaysPerWeek: 3,
      startDate: '2026-03-23',
    })

    const exercises = await getDb()
      .selectFrom('exercises')
      .innerJoin('workouts', 'workouts.id', 'exercises.workout_id')
      .select(['exercises.name', 'exercises.weight'])
      .where('workouts.program_id', '=', result.draftProgramId)
      .execute()

    const squats = exercises.filter((e) => e.name === 'Squat')
    expect(squats.length).toBeGreaterThan(0)
    // Weight should be based on 180 kg e1RM, so > 0
    squats.forEach((e) => expect(e.weight).toBeGreaterThan(0))
  })

  it('works with 4 training days per week', async () => {
    const result = await generateDraftProgram(completedProgramId, {
      athleteId,
      templateId: 'strength_wave',
      weeks: 6,
      trainingDaysPerWeek: 4,
      startDate: '2026-03-30',
    })

    const workouts = await getDb()
      .selectFrom('workouts')
      .selectAll()
      .where('program_id', '=', result.draftProgramId)
      .execute()

    expect(workouts).toHaveLength(6 * 4)
  })
})
