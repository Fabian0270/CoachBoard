import { z } from 'zod'
import type { Response } from 'express'

const isoDate = z.iso.date('Expected YYYY-MM-DD')
const enabledColumnEnum = z.enum(['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe'])
const statusEnum = z.enum(['active', 'completed', 'archived'])

// HTML forms submit '' for untouched optional fields — treat that as null/absent
// so optional dates, emails etc. don't fail their format checks.
const emptyToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v)
const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v)

const optionalString = (max: number) => z.preprocess(emptyToNull, z.string().max(max).nullable().optional())
const optionalIsoDate = z.preprocess(emptyToNull, isoDate.nullable().optional())
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
    }).refine(dateRangeValid, dateRangeIssue),
    update: z.object({
      name: z.string().min(1).max(200).optional(),
      description: optionalString(2000),
      start_date: optionalIsoDate,
      end_date: optionalIsoDate,
      status: statusEnum.optional(),
      enabled_columns: z.array(enabledColumnEnum).nullable().optional(),
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
    }),
  },

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
}

export function validate<T>(schema: z.ZodType<T>, data: unknown, res: Response): T | null {
  const result = schema.safeParse(data)
  if (!result.success) {
    res.status(400).json({ error: 'Validation error', details: result.error.flatten() })
    return null
  }
  return result.data
}
