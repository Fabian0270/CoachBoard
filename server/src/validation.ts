import { z } from 'zod'
import type { Response } from 'express'

const isoDate = z.iso.date('Expected YYYY-MM-DD')
const enabledColumnEnum = z.enum(['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe'])
const statusEnum = z.enum(['active', 'completed', 'archived', 'draft'])
const focusEnum = z.enum(['hypertrophy', 'strength', 'peaking'])

// HTML forms submit '' for untouched optional fields — treat that as null/absent
// so optional dates, emails etc. don't fail their format checks.
const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v)
const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)

const optionalString = (max: number) => z.preprocess(emptyToNull, z.string().max(max).nullable().optional())
const optionalIsoDate = z.preprocess(emptyToNull, isoDate.nullable().optional())
const optionalFocus = z.preprocess(emptyToNull, focusEnum.nullable().optional())
const optionalEmail = z.preprocess(emptyToNull, z.email().max(200).nullable().optional())

const dateRangeValid = (data: { start_date?: string | null; end_date?: string | null }) =>
  !data.start_date || !data.end_date || data.start_date <= data.end_date
const dateRangeIssue = { message: 'end_date must be on or after start_date', path: ['end_date'] }

export const schemas = {
  athlete: {
    create: z.object({
      name: z.string().min(1).max(200),
      email: optionalEmail,
      sport: optionalString(100),
      date_of_birth: optionalIsoDate,
      notes: optionalString(2000),
      // Set when creating a minimal owner for a historical back-catalogue import.
      archived: z.boolean().optional(),
    }),
    update: z.object({
      name: z.string().min(1).max(200).optional(),
      email: optionalEmail,
      sport: optionalString(100),
      date_of_birth: optionalIsoDate,
      notes: optionalString(2000),
    }),
  },

  program: {
    create: z.object({
      athlete_id: z.uuid(),
      name: z.string().min(1).max(200),
      description: optionalString(2000),
      start_date: optionalIsoDate,
      end_date: optionalIsoDate,
      status: statusEnum.optional(),
      enabled_columns: z.array(enabledColumnEnum).nullable().optional(),
      focus: optionalFocus,
      // Manual "reuse a saved style" — copy export_layout from this program …
      style_source_program_id: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
      // … or apply a saved style from the export-style library (takes precedence).
      export_style_id: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
    }).refine(dateRangeValid, dateRangeIssue),
    update: z.object({
      name: z.string().min(1).max(200).optional(),
      description: optionalString(2000),
      start_date: optionalIsoDate,
      end_date: optionalIsoDate,
      status: statusEnum.optional(),
      enabled_columns: z.array(enabledColumnEnum).nullable().optional(),
      focus: optionalFocus,
      // Reassign an unassigned (or any) program to an athlete. Only a real athlete
      // id — detaching to NULL happens through the athlete-delete "keep programs" path.
      athlete_id: z.uuid().optional(),
    }).refine(dateRangeValid, dateRangeIssue),
    duration: z.object({
      start_date: isoDate,
      weeks: z.number().int().min(1).max(52),
    }),
  },

  workout: {
    create: z.object({
      name: z.string().max(200).optional(),
      scheduled_date: optionalIsoDate,
      notes: optionalString(2000),
    }),
    update: z.object({
      name: z.string().max(200).optional(),
      scheduled_date: optionalIsoDate,
      notes: optionalString(2000),
    }),
  },

  exercise: {
    create: z.object({
      name: z.string().max(200).optional(),
      sets: optionalString(50),
      reps: optionalString(50),
      weight: z.number().min(0).nullable().optional(),
      duration: z.number().int().min(0).nullable().optional(),
      distance: z.number().min(0).nullable().optional(),
      notes: optionalString(2000),
      order_index: z.number().int().min(0).optional(),
      rest_time: optionalString(50),
      intensity: optionalString(100),
      load_used: optionalString(100),
      rpe: optionalString(50),
      group_id: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
    }),
    update: z.object({
      name: z.string().max(200).optional(),
      sets: optionalString(50),
      reps: optionalString(50),
      weight: z.number().min(0).nullable().optional(),
      duration: z.number().int().min(0).nullable().optional(),
      distance: z.number().min(0).nullable().optional(),
      notes: optionalString(2000),
      order_index: z.number().int().min(0).optional(),
      rest_time: optionalString(50),
      intensity: optionalString(100),
      load_used: optionalString(100),
      rpe: optionalString(50),
      group_id: z.preprocess(emptyToNull, z.uuid().nullable().optional()),
    }),
  },

  copyDay: z.object({
    sourceDate: isoDate,
    targetDates: z.array(isoDate).min(1).max(52),
  }),

  moveDay: z.object({
    sourceDate: isoDate,
    targetDate: isoDate,
  }),

  reorderExercises: z.object({
    exerciseIds: z.array(z.string().uuid()).min(1).max(200),
  }),

  athleteMax: {
    create: z.object({
      lift_name: z.string().min(1).max(100),
      weight: z.number().positive().finite(),
      unit: z.preprocess(emptyToNull, z.string().max(20).nullable().optional()),
      recorded_at: z.preprocess(emptyToUndefined, isoDate.optional()),
      notes: optionalString(2000),
    }),
  },

  suggestion: z.object({
    athleteId: z.uuid(),
    templateId: z.string().min(1).max(100),
    weeks: z.number().int().min(1).max(52),
    trainingDaysPerWeek: z.number().int().min(3).max(5),
    startDate: isoDate,
    layout: z.enum(['source', 'split']).optional(),
    enrichAccessories: z.boolean().optional(),
    // Optional style nudges from the coach's profile (Feature 5c).
    style: z.object({
      startRpe: z.number().min(5).max(10).optional(),
      peakRpe: z.number().min(5).max(10).optional(),
      repBias: z.number().int().min(-2).max(2).optional(),
    }).optional(),
  }),

  // Commit metadata for external program import — arrives as query-string params.
  // Archived (historical) programs don't require a start date; active/completed do.
  externalImportCommit: z.object({
    athlete_id: z.uuid(),
    name: z.string().min(1).max(200),
    status: z.enum(['active', 'completed', 'archived']),
    start_date: optionalIsoDate,
    focus: optionalFocus,
    // Opt-in: also save the captured layout into the reusable style library.
    // Query-string booleans arrive as the string "1"/"true".
    save_style: z.preprocess(
      (v) => v === '1' || v === 'true' || v === true,
      z.boolean().optional(),
    ),
    style_name: optionalString(100),
  }).refine(
    (data) => data.status === 'archived' || !!data.start_date,
    { message: 'start_date is required unless the program is archived', path: ['start_date'] },
  ),

  progress: {
    create: z.object({
      athlete_id: z.uuid(),
      metric_name: z.string().min(1).max(100),
      value: z.number().finite(),
      unit: optionalString(50),
      // Accept either a plain date (what the date picker sends) or a full ISO datetime.
      recorded_at: z.preprocess(
        emptyToUndefined,
        z.union([isoDate, z.iso.datetime({ offset: true, local: true })]).optional(),
      ),
      notes: optionalString(2000),
    }),
  },

  payment: {
    create: z.object({
      athlete_id: z.uuid(),
      amount: z.number().positive().finite(),
      currency: z.string().min(1).max(10),
      start_date: optionalIsoDate,
      paid_through: isoDate,
      paid: z.boolean().optional(),
      paid_at: optionalIsoDate,
      notes: optionalString(2000),
    }).refine(
      (d) => !d.start_date || !d.paid_through || d.start_date <= d.paid_through,
      { message: 'paid_through must be on or after start_date', path: ['paid_through'] },
    ),
    update: z.object({
      amount: z.number().positive().finite().optional(),
      currency: z.string().min(1).max(10).optional(),
      start_date: optionalIsoDate,
      paid_through: isoDate.optional(),
      paid: z.boolean().optional(),
      paid_at: optionalIsoDate,
      notes: optionalString(2000),
    }).refine(
      (d) => !d.start_date || !d.paid_through || d.start_date <= d.paid_through,
      { message: 'paid_through must be on or after start_date', path: ['paid_through'] },
    ),
  },
}

export function validate<T>(schema: z.ZodType<T>, data: unknown, res: Response): T | null {
  const result = schema.safeParse(data)
  if (!result.success) {
    res.status(400).json({ error: 'Validation error', details: result.error.flatten() })
    return null
  }
  return result.data
}
