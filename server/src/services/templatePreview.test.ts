import { describe, it, expect } from 'vitest'
import { buildTemplateSamplePreviewHtml, TemplatePreviewError } from './templatePreview.js'
import { getE1RMReference, e1rmForExerciseName } from './exportE1RM.js'

describe('buildTemplateSamplePreviewHtml', () => {
  it('renders each built-in template from sample data', async () => {
    for (const id of ['coachboard', 'minimal', 'modern']) {
      const html = await buildTemplateSamplePreviewHtml(id)
      expect(html).toContain('Back Squat')
      expect(html).toContain('Week 1')
      expect(html.length).toBeGreaterThan(100)
    }
  })

  it('shows an e1RM reference badge in the Modern template', async () => {
    const html = await buildTemplateSamplePreviewHtml('modern')
    expect(html).toContain('e1RM')
    expect(html).toContain('175') // sample squat e1RM
  })

  it('rejects an unknown template id', async () => {
    await expect(buildTemplateSamplePreviewHtml('nope')).rejects.toBeInstanceOf(TemplatePreviewError)
  })
})

describe('getE1RMReference — logged-set estimation (no stored maxes)', () => {
  it('estimates a per-lift e1RM from logged sets and matches by exercise name', async () => {
    const exercises = [
      { name: 'Back Squat', reps: '5', load_used: '150', rpe: '8' },
      { name: 'Bench Press', reps: '3', load_used: '100', rpe: '9' },
      { name: 'Bicep Curl', reps: '10', load_used: '20', rpe: '8' }, // not a main lift
    ]
    const ref = await getE1RMReference(null, exercises)
    expect(ref.squat).toBeGreaterThan(150)
    expect(ref.bench).toBeGreaterThan(100)
    expect(ref.deadlift).toBeUndefined()
    expect(e1rmForExerciseName('Back Squat', ref)).toBe(ref.squat)
    expect(e1rmForExerciseName('Bicep Curl', ref)).toBeNull()
  })
})
