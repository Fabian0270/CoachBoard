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
    { date: '2026-01-29', lift: 'Bench Press', loadUsed: '95',  rpe: '8', accessories: ['Comp Bench', 'Tricep Pushdown'] },
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
    // Accessories — seeded with a stale weight + RPE so we can assert they are
    // stripped (not carried verbatim) in the generated draft.
    for (let i = 0; i < day.accessories.length; i++) {
      await createExercise({
        workout_id: workout.id,
        name: day.accessories[i],
        sets: '3',
        reps: '10',
        weight: 50,
        intensity: 'RPE 7',
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

  it('carried accessories keep their sets×reps scaffold but strip stale load + RPE', async () => {
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
    expect(accessories.length).toBeGreaterThan(0)
    accessories.forEach((e) => {
      // Scaffold preserved...
      expect(e.sets).toBe('3')
      expect(e.reps).toBe('10')
      // ...stale numbers stripped.
      expect(e.weight).toBeNull()
      expect(e.intensity).toBeNull()
      expect(e.load_used).toBeNull()
      expect(e.suggestion_note).toBeNull()
    })
  })

  it('folds a competition/variation lift into the main lift instead of duplicating it', async () => {
    const result = await generateDraftProgram(completedProgramId, {
      athleteId,
      templateId: 'strength_linear',
      weeks: 4,
      trainingDaysPerWeek: 3,
      startDate: '2026-02-27',
    })

    const exercises = await getDb()
      .selectFrom('exercises')
      .innerJoin('workouts', 'workouts.id', 'exercises.workout_id')
      .select(['exercises.name'])
      .where('workouts.program_id', '=', result.draftProgramId)
      .execute()

    // "Comp Bench" was seeded as a second bench movement on the bench day; it must
    // fold into the generated "Bench Press", not appear as its own line.
    expect(exercises.some((e) => e.name === 'Comp Bench')).toBe(false)
    expect(exercises.some((e) => e.name === 'Bench Press')).toBe(true)
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

  it('throws when source program is neither completed nor archived', async () => {
    const active = await createProgram({ athlete_id: athleteId, name: 'Active', status: 'active' })
    await expect(
      generateDraftProgram(active.id, {
        athleteId,
        templateId: 'strength_linear',
        weeks: 4,
        trainingDaysPerWeek: 3,
        startDate: '2026-03-16',
      }),
    ).rejects.toThrow('completed or archived')
  })

  it('accepts an archived back-catalogue program as the source', async () => {
    // Reuse the seeded block's structure, but as an archived historical program.
    const archived = await createProgram({
      athlete_id: athleteId, name: 'Old Block', start_date: '2025-09-01', status: 'active',
    })
    const w = await createWorkout({ program_id: archived.id, name: '2025-09-26', scheduled_date: '2025-09-26' })
    await createExercise({
      workout_id: w.id, name: 'Squat', sets: '4', reps: '5', weight: 150,
      intensity: 'RPE 8', load_used: '150', rpe: '8', order_index: 0,
    })
    await updateProgram(archived.id, { status: 'archived' })

    const result = await generateDraftProgram(archived.id, {
      athleteId,
      templateId: 'strength_linear',
      weeks: 4,
      trainingDaysPerWeek: 3,
      startDate: '2026-04-06',
    })
    const draft = await getDb().selectFrom('programs').selectAll().where('id', '=', result.draftProgramId).executeTakeFirstOrThrow()
    expect(draft.status).toBe('draft')
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
      layout: 'split',
    })

    const workouts = await getDb()
      .selectFrom('workouts')
      .selectAll()
      .where('program_id', '=', result.draftProgramId)
      .execute()

    expect(workouts).toHaveLength(6 * 4)
  })

  // A source whose last week is a single full-body day: Squat + Bench + Deadlift
  // together, each followed by its own accessory.
  async function seedSbdProgram(name: string): Promise<string> {
    const sbd = await createProgram({ athlete_id: athleteId, name, start_date: '2025-06-02', status: 'active' })
    const w = await createWorkout({ program_id: sbd.id, name: '2025-06-02', scheduled_date: '2025-06-02' }) // Monday
    await createExercise({ workout_id: w.id, name: 'Squat', sets: '4', reps: '5', weight: 150, intensity: 'RPE 8', load_used: '150', rpe: '8', order_index: 0 })
    await createExercise({ workout_id: w.id, name: 'Leg Curl', sets: '3', reps: '10', weight: 40, intensity: 'RPE 7', order_index: 1 })
    await createExercise({ workout_id: w.id, name: 'Bench Press', sets: '4', reps: '5', weight: 100, intensity: 'RPE 8', load_used: '100', rpe: '8', order_index: 2 })
    await createExercise({ workout_id: w.id, name: 'Tricep Pushdown', sets: '3', reps: '12', weight: 30, intensity: 'RPE 7', order_index: 3 })
    await createExercise({ workout_id: w.id, name: 'Deadlift', sets: '4', reps: '5', weight: 200, intensity: 'RPE 8', load_used: '200', rpe: '8', order_index: 4 })
    await createExercise({ workout_id: w.id, name: 'RDL', sets: '3', reps: '8', weight: 120, intensity: 'RPE 7', order_index: 5 })
    await updateProgram(sbd.id, { status: 'completed' })
    return sbd.id
  }

  it('mirrors a full-body SBD source day, grouping all three lifts with their accessories', async () => {
    const sbdId = await seedSbdProgram('SBD Block')

    const result = await generateDraftProgram(sbdId, {
      athleteId,
      templateId: 'strength_linear',
      weeks: 4,
      trainingDaysPerWeek: 3,
      startDate: '2026-05-04', // Monday
      // no layout → defaults to 'source' (mirror)
    })

    const workouts = await getDb()
      .selectFrom('workouts')
      .selectAll()
      .where('program_id', '=', result.draftProgramId)
      .orderBy('scheduled_date')
      .execute()

    // One full-body day per week → 4 workouts (frequency preserved), not a 3-day split.
    expect(workouts).toHaveLength(4)

    const rows = await getDb()
      .selectFrom('exercises')
      .innerJoin('workouts', 'workouts.id', 'exercises.workout_id')
      .select(['exercises.workout_id', 'exercises.name', 'exercises.order_index'])
      .where('workouts.program_id', '=', result.draftProgramId)
      .execute()

    // The single day carries all three lifts, each immediately followed by its own
    // accessory — proving both the SBD grouping and correct accessory attribution.
    const ordered = rows
      .filter((r) => r.workout_id === workouts[0].id)
      .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
      .map((r) => r.name)
    expect(ordered).toEqual(['Squat', 'Leg Curl', 'Bench Press', 'Tricep Pushdown', 'Deadlift', 'RDL'])
  })

  // A completed source whose squat day has a main lift but NO accessories — the
  // gap that smart-accessory enrichment is allowed to fill.
  async function seedNoAccessoryProgram(name: string): Promise<string> {
    const p = await createProgram({ athlete_id: athleteId, name, start_date: '2025-07-07', status: 'active' })
    const w = await createWorkout({ program_id: p.id, name: '2025-07-07', scheduled_date: '2025-07-07' }) // Monday
    await createExercise({ workout_id: w.id, name: 'Squat', sets: '4', reps: '5', weight: 150, intensity: 'RPE 8', load_used: '150', rpe: '8', order_index: 0 })
    await updateProgram(p.id, { status: 'completed' })
    return p.id
  }

  it('does NOT add suggested accessories by default (enrichAccessories off)', async () => {
    const id = await seedNoAccessoryProgram('No-Accessory Block (default)')

    const result = await generateDraftProgram(id, {
      athleteId,
      templateId: 'strength_linear',
      weeks: 2,
      trainingDaysPerWeek: 3,
      startDate: '2026-06-01', // Monday
    })

    const rows = await getDb()
      .selectFrom('exercises')
      .innerJoin('workouts', 'workouts.id', 'exercises.workout_id')
      .select(['exercises.name', 'exercises.suggestion_note'])
      .where('workouts.program_id', '=', result.draftProgramId)
      .execute()

    // Only the generated Squat main lift — no engine-suggested accessories.
    expect(rows.every((r) => r.name === 'Squat')).toBe(true)
  })

  it('fills empty main-lift days with tagged suggestions when enrichAccessories is on', async () => {
    const id = await seedNoAccessoryProgram('No-Accessory Block (enriched)')

    const result = await generateDraftProgram(id, {
      athleteId,
      templateId: 'strength_linear',
      weeks: 2,
      trainingDaysPerWeek: 3,
      startDate: '2026-06-15', // Monday
      enrichAccessories: true,
    })

    const rows = await getDb()
      .selectFrom('exercises')
      .innerJoin('workouts', 'workouts.id', 'exercises.workout_id')
      .selectAll('exercises')
      .where('workouts.program_id', '=', result.draftProgramId)
      .execute()

    const suggested = rows.filter((r) => r.name !== 'Squat')
    // 3 suggestions per squat day × 2 weeks = 6.
    expect(suggested).toHaveLength(6)
    suggested.forEach((r) => {
      expect(r.suggestion_note).toContain('Engine-suggested')
      expect(r.weight).toBeNull()       // no prescribed load on a suggestion
      expect(r.intensity).toBeNull()
      expect(r.sets).toBe('3')
      expect(r.reps).toMatch(/^\d+-\d+$/) // rep range from the knowledge base
    })
  })

  it('never overrides accessories the coach already has, even with enrichAccessories on', async () => {
    // completedProgramId's squat day already carries Leg Press + Leg Curl.
    const result = await generateDraftProgram(completedProgramId, {
      athleteId,
      templateId: 'strength_linear',
      weeks: 2,
      trainingDaysPerWeek: 3,
      startDate: '2026-06-22', // Monday
      enrichAccessories: true,
    })

    const rows = await getDb()
      .selectFrom('exercises')
      .innerJoin('workouts', 'workouts.id', 'exercises.workout_id')
      .selectAll('exercises')
      .where('workouts.program_id', '=', result.draftProgramId)
      .execute()

    // The coach's carried-over accessories are present and untagged.
    const legPress = rows.filter((r) => r.name === 'Leg Press')
    expect(legPress.length).toBeGreaterThan(0)
    legPress.forEach((r) => expect(r.suggestion_note).toBeNull())
    // And no engine suggestion was injected onto a day that already had accessories.
    expect(rows.some((r) => (r.suggestion_note ?? '').includes('Engine-suggested'))).toBe(false)
  })

  it('splits an SBD source into one lift per day when layout = "split"', async () => {
    const sbdId = await seedSbdProgram('SBD Block (split override)')

    const result = await generateDraftProgram(sbdId, {
      athleteId,
      templateId: 'strength_linear',
      weeks: 4,
      trainingDaysPerWeek: 3,
      startDate: '2026-05-18', // Monday
      layout: 'split',
    })

    const workouts = await getDb()
      .selectFrom('workouts')
      .selectAll()
      .where('program_id', '=', result.draftProgramId)
      .execute()

    // 4 weeks × 3 separate days.
    expect(workouts).toHaveLength(12)

    const rows = await getDb()
      .selectFrom('exercises')
      .innerJoin('workouts', 'workouts.id', 'exercises.workout_id')
      .select(['exercises.workout_id', 'exercises.name'])
      .where('workouts.program_id', '=', result.draftProgramId)
      .execute()

    // Each workout holds exactly one main lift.
    workouts.forEach((wo) => {
      const mains = rows.filter(
        (r) => r.workout_id === wo.id && ['Squat', 'Bench Press', 'Deadlift'].includes(r.name),
      )
      expect(mains).toHaveLength(1)
    })
  })
})
