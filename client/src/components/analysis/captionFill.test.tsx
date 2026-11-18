// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import { captionFill } from './captionFill'
import VelocityPanel from './VelocityPanel'
import { renderScreen } from '../../test/render'

// What the Discord caption fills in on the bar path page (BP14).

const cap = (over: Record<string, unknown>) => ({ weight: null, unit: 'kg' as const, reps: null, rpe: null, liftKeywords: [], ...over })

describe('captionFill', () => {
  it('fills the lift, load, reps and RPE a caption gives', () => {
    expect(captionFill(cap({ weight: 180, reps: 2, rpe: 8, liftKeywords: ['bench'] }))).toEqual({
      lift: 'bench-press', load: 180, reps: 2, rpe: 8,
    })
  })
  it('only a lift that is certain: two lifts named say nothing about this clip', () => {
    expect(captionFill(cap({ liftKeywords: ['squat', 'bench'] })).lift).toBeUndefined()
  })
  it('only an RPE the page can take: a half step from 5 to 10', () => {
    expect(captionFill(cap({ rpe: 8.5 })).rpe).toBe(8.5)
    expect(captionFill(cap({ rpe: 4 })).rpe).toBeUndefined()
    expect(captionFill(cap({ rpe: 8.3 })).rpe).toBeUndefined()
  })
  it('nothing without a caption', () => {
    expect(captionFill(null)).toEqual({})
  })
})

describe('VelocityPanel — from caption', () => {
  it('marks the fields the caption filled in', () => {
    renderScreen(
      <VelocityPanel
        reps={[]} calibrated athleteName={null} anchors={[]} savedPoints={[]} maxes={[]}
        value={{ lift: 'bench-press', loadText: '180', calledRpe: 8, repsText: '2', metric: null }}
        onChange={() => {}}
        fromCaption={new Set(['load', 'rpe'] as const)}
      />,
    )
    expect(screen.getAllByText('· from caption')).toHaveLength(2)
    expect(screen.getByText('Load').parentElement?.textContent).toContain('from caption')
    expect(screen.getByText('Lift').textContent).toBe('Lift')
  })
})
