// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { useState } from 'react'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderScreen, serve } from '../../test/render'
import TrainingDayLink, { NO_LINK, type DayLink } from './TrainingDayLink'
import type { AnalysisLinkDay } from 'coachboard-shared/videoAnalysis'

// L2 (D67): the link follows the clip until the coach picks.

const days: AnalysisLinkDay[] = [
  {
    workoutId: 'w1', date: '2026-11-17', workoutName: 'Heavy day', programId: 'p1', programName: 'Block',
    suggestedExerciseId: 'e1',
    rows: [
      { exerciseId: 'e1', name: 'Squat', sets: '1', reps: '3', weight: 180, loadUsed: null, velocity: null, fits: true },
      { exerciseId: 'e2', name: 'Bench', sets: '3', reps: '5', weight: 100, loadUsed: null, velocity: null, fits: false },
    ],
  },
  {
    workoutId: 'w2', date: '2026-11-19', workoutName: 'Light day', programId: 'p1', programName: 'Block',
    suggestedExerciseId: null,
    rows: [{ exerciseId: 'e3', name: 'Squat', sets: '3', reps: '5', weight: 140, loadUsed: null, velocity: null, fits: true }],
  },
]

let resolved: DayLink = NO_LINK
function Harness({ preferred, athleteId = 'a1' }: { preferred: string | null; athleteId?: string | null }) {
  const [choice, setChoice] = useState<DayLink | null>(null)
  return (
    <TrainingDayLink
      athleteId={athleteId} day="2026-11-17" lift="back-squat" loadKg={180}
      preferredWorkoutId={preferred} choice={choice} onChoose={setChoice} onResolved={(l) => { resolved = l }}
    />
  )
}

describe('TrainingDayLink', () => {
  it("picks the clip's day and the one row that fits", async () => {
    const server = serve({ '/api/analysis/link-candidates': { body: days } })
    renderScreen(<Harness preferred="w1" />)
    await waitFor(() => expect(resolved).toMatchObject({ workoutId: 'w1', exerciseId: 'e1', exerciseName: 'Squat' }))
    expect((screen.getByLabelText('Training day') as HTMLSelectElement).value).toBe('w1')
    expect((screen.getByLabelText('Exercise') as HTMLSelectElement).value).toBe('e1')
    expect(server.calls[0]).toContain('lift=back-squat')
    expect(server.calls[0]).toContain('loadKg=180')
  })

  it('a clip from the computer is not linked until the coach picks', async () => {
    serve({ '/api/analysis/link-candidates': { body: days } })
    renderScreen(<Harness preferred={null} />)
    const daySelect = await screen.findByLabelText('Training day')
    expect(resolved).toMatchObject(NO_LINK)
    await userEvent.selectOptions(daySelect, 'w2')
    // No single fit on that day: the day only, until a row is picked.
    await waitFor(() => expect(resolved).toMatchObject({ workoutId: 'w2', exerciseId: null }))
    await userEvent.selectOptions(screen.getByLabelText('Exercise'), 'e3')
    await waitFor(() => expect(resolved).toMatchObject({ workoutId: 'w2', exerciseId: 'e3' }))
  })

  it('says so when there is no day near the set', async () => {
    serve({ '/api/analysis/link-candidates': { body: [] } })
    renderScreen(<Harness preferred={null} />)
    expect(await screen.findByText('No training day within a week of this set.')).toBeTruthy()
  })

  it('shows nothing without an athlete', () => {
    serve({})
    const { container } = renderScreen(<Harness preferred="w1" athleteId={null} />)
    expect(container.textContent).toBe('')
  })
})
