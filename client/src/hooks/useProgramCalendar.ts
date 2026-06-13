import { useMemo } from 'react'
import type { Program, Workout } from '../lib/programUtils'
import { parseIsoDate, toIsoDate, mondayOf, weeksBetween, addDays } from '../lib/programUtils'

export interface CalendarGrid {
  weeks: number
  rows: { weekIndex: number; days: { date: string; label: number }[] }[]
}

export function useProgramCalendar(program: Program | null): CalendarGrid | null {
  return useMemo(() => {
    if (!program?.start_date) return null
    const startMonday = mondayOf(parseIsoDate(program.start_date))
    const weeks = program.end_date
      ? weeksBetween(toIsoDate(startMonday), program.end_date)
      : 4
    const rows: CalendarGrid['rows'] = []
    for (let w = 0; w < weeks; w++) {
      const days: { date: string; label: number }[] = []
      for (let d = 0; d < 7; d++) {
        const date = addDays(startMonday, w * 7 + d)
        days.push({ date: toIsoDate(date), label: date.getUTCDate() })
      }
      rows.push({ weekIndex: w, days })
    }
    return { weeks, rows }
  }, [program?.start_date, program?.end_date])
}

export function useWorkoutByDate(program: Program | null): Map<string, Workout> {
  return useMemo(() => {
    const m = new Map<string, Workout>()
    for (const w of program?.workouts ?? []) {
      if (w.scheduled_date) m.set(w.scheduled_date, w)
    }
    return m
  }, [program?.workouts])
}
