import type {
  Exercise,
  Workout,
  Program as SharedProgram,
  ToggleableColumn,
} from 'coachboard-shared'

export { TOGGLEABLE_COLUMNS } from 'coachboard-shared'
export type { Exercise, Workout, ToggleableColumn }

// The program detail API always includes workouts, so narrow the shared type.
export interface Program extends SharedProgram {
  workouts: Workout[]
}

export const COLUMN_LABELS: Record<ToggleableColumn, string> = {
  rest_time: 'Rest Time (mins)',
  intensity: 'Intensity/Weight',
  load_cap: 'Load Cap',
  load_used: 'Load Used',
  rpe: 'Last Set RPE',
}

export type ColKey = 'name' | 'sets' | 'reps' | ToggleableColumn

export interface ColDef {
  key: ColKey
  label: string
  width?: number
  numeric?: boolean
  placeholder?: string
}

export const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function toIsoDate(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function parseIsoDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

export function mondayOf(d: Date): Date {
  const day = d.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  const monday = new Date(d)
  monday.setUTCDate(d.getUTCDate() + diff)
  return monday
}

export function addDays(d: Date, days: number): Date {
  const r = new Date(d)
  r.setUTCDate(d.getUTCDate() + days)
  return r
}

export function weeksBetween(start: string, end: string): number {
  const s = parseIsoDate(start)
  const e = parseIsoDate(end)
  const diffDays = Math.round((e.getTime() - s.getTime()) / 86400000) + 1
  return Math.max(1, Math.ceil(diffDays / 7))
}

export function dayName(date: string): string {
  const d = parseIsoDate(date)
  return DAY_LABELS[(d.getUTCDay() + 6) % 7]
}

function asStr(v: unknown): string {
  return v == null ? '' : String(v)
}

export function exerciseValue(ex: Exercise, key: ColKey): string {
  switch (key) {
    case 'name': return ex.name ?? ''
    case 'sets': return asStr(ex.sets)
    case 'reps': return asStr(ex.reps)
    case 'load_cap': return asStr(ex.weight)
    case 'rest_time': return ex.rest_time ?? ''
    case 'intensity': return ex.intensity ?? ''
    case 'load_used': return ex.load_used ?? ''
    case 'rpe': return ex.rpe ?? ''
    default: {
      const _exhaustive: never = key
      void _exhaustive
      return ''
    }
  }
}

export const DEFAULT_COL_WIDTH: Record<ColKey, number> = {
  name: 220,
  sets: 64,
  reps: 64,
  rest_time: 80,
  intensity: 140,
  load_cap: 90,
  load_used: 90,
  rpe: 90,
}

export function buildColumns(enabled: ToggleableColumn[]): ColDef[] {
  const cols: ColDef[] = [{ key: 'name', label: 'Exercise', placeholder: 'Exercise name' }]
  if (enabled.includes('rest_time')) cols.push({ key: 'rest_time', label: 'Rest (min)', width: 80, placeholder: 'e.g. 2 or 2-3' })
  cols.push({ key: 'sets', label: 'Sets', width: 64, placeholder: '3 or 3-5' })
  cols.push({ key: 'reps', label: 'Reps', width: 64, placeholder: '8 or 8-12' })
  if (enabled.includes('intensity')) cols.push({ key: 'intensity', label: 'Intensity/Weight', width: 140, placeholder: 'e.g. RPE 8, 70%' })
  if (enabled.includes('load_cap')) cols.push({ key: 'load_cap', label: 'Load Cap', width: 90, numeric: true })
  if (enabled.includes('load_used')) cols.push({ key: 'load_used', label: 'Load Used', width: 90 })
  if (enabled.includes('rpe')) cols.push({ key: 'rpe', label: 'Last Set RPE', width: 90, placeholder: 'e.g. 8' })
  return cols
}

export const pendingWorkoutCreations = new Map<string, Promise<Workout | null>>()
