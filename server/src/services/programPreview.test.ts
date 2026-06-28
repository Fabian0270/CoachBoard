import { describe, it, expect } from 'vitest'
import type { ExportLayoutTemplate } from 'coachboard-shared'
import { renderProgramWorkbook } from './exportService.js'
import { renderWorkbookHtml } from './programPreview.js'

// 2026-01-05 is a Monday; one Monday workout in a 1-week program.
const START = '2026-01-05'
const END = '2026-01-11'

const exercise = {
  name: 'Squat', sets: '3', reps: '5', weight: null as number | null,
  rest_time: null as string | null, intensity: null as string | null,
  load_used: null as string | null, rpe: '8' as string | null,
  group_id: null as string | null, order_index: 0, workout_id: 'w1',
}
const workouts = [{ id: 'w1', scheduled_date: START }]

function program(export_layout: string | null, enabled_columns: string | null = null) {
  return { name: 'Test Program', start_date: START, end_date: END, enabled_columns, export_layout }
}

describe('renderWorkbookHtml', () => {
  it('renders the workbook content and replays the coach colors as inline styles', async () => {
    const template: ExportLayoutTemplate = {
      version: 1,
      orientation: 'horizontal',
      columns: [
        { key: 'name', label: 'Movement' },
        { key: 'sets', label: 'Set' },
        { key: 'reps', label: 'Reps' },
        { key: 'rpe', label: 'RPE' },
      ],
      dayLabels: { style: 'weekday', language: 'en' },
      rpeNotation: 'at',
      colors: {
        weekBanner: 'FFAA0000', dayHeader: 'FFAA0000',
        columnHeader: 'FF0000BB', trackingHeader: 'FF00BB00', body: null,
      },
      fonts: { headerBold: true, headerItalic: false, nameBold: true },
    }
    const buf = await renderProgramWorkbook(program(JSON.stringify(template)), workouts, [exercise])
    const html = await renderWorkbookHtml(buf)

    // Content the coach is checking for.
    expect(html).toContain('Week 1')
    expect(html).toContain('Movement')
    expect(html).toContain('Squat')
    expect(html).toContain('@8')

    // Captured fills carried through as #RRGGBB backgrounds.
    expect(html).toContain('background:#AA0000') // week banner / day header
    expect(html).toContain('background:#0000BB') // column header
    expect(html).toContain('background:#00BB00') // tracking (RPE) header

    // Structural: a table with a colgroup for widths.
    expect(html).toContain('<table class="xlsx-preview">')
    expect(html).toContain('<colgroup>')
  })

  it('escapes cell text', async () => {
    const evil = { ...exercise, name: '<script>' }
    const buf = await renderProgramWorkbook(program(null, JSON.stringify(['rpe'])), workouts, [evil])
    const html = await renderWorkbookHtml(buf)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
