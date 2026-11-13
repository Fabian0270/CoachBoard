import { describe, it, expect } from 'vitest'
import { parseExportLayout, MINIMAL_DESCRIPTOR } from 'coachboard-shared/exportLayout'

// A stored layout is read by the renderer field by field. Only three fields
// used to be checked, so a row missing the rest passed here and then threw
// inside the export, making that program impossible to export at all.

describe('parseExportLayout', () => {
  const valid = JSON.stringify(MINIMAL_DESCRIPTOR)

  it('accepts a complete layout', () => {
    expect(parseExportLayout(valid)).toEqual(MINIMAL_DESCRIPTOR)
  })

  it.each([
    ['no colors', { colors: undefined }],
    ['no fonts', { fonts: undefined }],
    ['no day labels', { dayLabels: undefined }],
    ['an unknown day-label style', { dayLabels: { style: 'roman', language: 'en' } }],
    ['an unknown orientation', { orientation: 'diagonal' }],
    ['an unknown RPE notation', { rpeNotation: '#' }],
    ['a column the renderer does not know', { columns: [{ key: 'tempo', label: 'Tempo' }] }],
    ['a column without a label', { columns: [{ key: 'name' }] }],
  ])('rejects a layout with %s', (_what, change) => {
    expect(parseExportLayout(JSON.stringify({ ...MINIMAL_DESCRIPTOR, ...change }))).toBeNull()
  })

  it('rejects junk', () => {
    expect(parseExportLayout('not json')).toBeNull()
    expect(parseExportLayout('[]')).toBeNull()
    expect(parseExportLayout(null)).toBeNull()
  })
})
