import { describe, it, expect } from 'vitest'
import { buildTemplateSamplePreviewHtml, TemplatePreviewError } from './templatePreview.js'
import { latestE1RMByLift } from './analysisService.js'
import { e1rmForExerciseName } from './exportE1RM.js'

describe('buildTemplateSamplePreviewHtml', () => {
  it('renders each built-in template from sample data', async () => {
    for (const id of ['coachboard', 'minimal', 'modern']) {
      const html = await buildTemplateSamplePreviewHtml(id)
      expect(html).toContain('Back Squat')
      expect(html).toContain('Week 1')
      expect(html.length).toBeGreaterThan(100)
    }
  })

  it('shows a computed e1RM reference badge in the Modern template', async () => {
    const html = await buildTemplateSamplePreviewHtml('modern')
    expect(html).toContain('e1RM')
    expect(html).toMatch(/e1RM\s+\d+(\.\d+)?\s*kg/) // badge carries an actual number
  })

  it('rejects an unknown template id', async () => {
    await expect(buildTemplateSamplePreviewHtml('nope')).rejects.toBeInstanceOf(TemplatePreviewError)
  })
})

describe('latestE1RMByLift — report-style estimation (logged sets only)', () => {
  const program = { start_date: '2026-01-05' }
  const workouts = [{ id: 'w1', scheduled_date: '2026-01-05' }]

  it('estimates a per-lift e1RM from logged sets and matches by exercise name', () => {
    const exercises = [
      { name: 'Back Squat', reps: '5', load_used: '150', rpe: '8', workout_id: 'w1' },
      { name: 'Bench Press', reps: '3', load_used: '100', rpe: '9', workout_id: 'w1' },
      { name: 'Bicep Curl', reps: '10', load_used: '20', rpe: '8', workout_id: 'w1' }, // not a main lift
      { name: 'Deadlift', reps: '5', load_used: null, rpe: '8', workout_id: 'w1' }, // not logged
    ]
    const ref = latestE1RMByLift(program, workouts, exercises)
    expect(ref.squat).toBeGreaterThan(150)
    expect(ref.bench).toBeGreaterThan(100)
    expect(ref.deadlift).toBeUndefined() // no stored-max fallback; not logged → absent
    expect(e1rmForExerciseName('Back Squat', ref)).toBe(ref.squat)
    expect(e1rmForExerciseName('Bicep Curl', ref)).toBeNull()
  })

  it('returns nothing when no sets are logged (badge mirrors the report)', () => {
    const exercises = [{ name: 'Back Squat', reps: '5', load_used: null, rpe: '8', workout_id: 'w1' }]
    expect(latestE1RMByLift(program, workouts, exercises)).toEqual({})
  })
})
