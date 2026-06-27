import { describe, it, expect } from 'vitest'
import { guessFocus } from './focus.js'
import type { ExternalExerciseRow } from 'coachboard-shared'

describe('guessFocus', () => {
  const row = (weekIndex: number, reps: string | null, rpe: string | null): ExternalExerciseRow => ({
    weekIndex, dayIndex: 0, weekLabel: `Week ${weekIndex + 1}`, dayLabel: 'Day 1',
    name: 'Squat', sets: '3', reps, load: '100', rpe, sheetRow: 1,
  })

  it('returns null when there are no numeric reps to judge from', () => {
    expect(guessFocus([row(0, 'AMRAP', null), row(0, null, null)])).toBeNull()
  })

  it('classifies high-rep work as hypertrophy', () => {
    expect(guessFocus([row(0, '10', '7'), row(0, '8', '8'), row(1, '8', '8')])).toBe('hypertrophy')
  })

  it('classifies mid-rep work as strength', () => {
    expect(guessFocus([row(0, '5', '7'), row(0, '5', '8'), row(1, '4', '8')])).toBe('strength')
  })

  it('classifies low-rep work as peaking', () => {
    expect(guessFocus([row(0, '3', '8'), row(0, '2', '9'), row(1, '1', '10')])).toBe('peaking')
  })

  it('uses a near-maximal final week to push a mid-rep block to peaking', () => {
    // Median reps land in the strength band (4–6) but the final week finishes at RPE 9+.
    expect(guessFocus([row(0, '5', '7'), row(1, '5', '9'), row(1, '4', '9.5')])).toBe('peaking')
  })

  it('reads the lower bound of a rep range', () => {
    // "4-6" → lower bound 4 → strength band (a hypertrophy median would need ≥7).
    expect(guessFocus([row(0, '4-6', '8'), row(1, '4-6', '8')])).toBe('strength')
  })
})
