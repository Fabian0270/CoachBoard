import { beforeAll, describe, it, expect } from 'vitest'
import { initializeDatabase } from '../db.js'
import { createAthlete } from './athleteService.js'
import { createProgram, findProgramById } from './programService.js'
import { createExportStyle, findAllExportStyles, renameExportStyle, deleteExportStyle } from './exportStyleService.js'
import type { ExportLayoutTemplate } from 'coachboard-shared'

const TEMPLATE: ExportLayoutTemplate = {
  version: 1,
  orientation: 'horizontal',
  columns: [
    { key: 'name', label: 'Movement' },
    { key: 'sets', label: 'Set' },
    { key: 'reps', label: 'Reps' },
  ],
  dayLabels: { style: 'weekday', language: 'en' },
  rpeNotation: 'plain',
  colors: { weekBanner: 'FFAA0000' },
  fonts: { headerBold: true },
}

let athleteId: string

beforeAll(async () => {
  await initializeDatabase(':memory:')
  athleteId = (await createAthlete({ name: 'Style Lib Athlete' })).id
})

describe('export style library', () => {
  it('creates and lists saved styles with parsed descriptors', async () => {
    const saved = await createExportStyle('Erik PL Block', TEMPLATE)
    const all = await findAllExportStyles()
    const found = all.find((s) => s.id === saved.id)
    expect(found?.name).toBe('Erik PL Block')
    expect(found?.descriptor.orientation).toBe('horizontal')
    expect(found?.descriptor.colors.weekBanner).toBe('FFAA0000')
  })

  it('applies a saved style to a new program via export_style_id', async () => {
    const saved = await createExportStyle('Erik PL Block 2', TEMPLATE)
    const created = await createProgram({ athlete_id: athleteId, name: 'New Block', export_style_id: saved.id })
    const program = await findProgramById(created.id)
    expect(program!.export_layout!.orientation).toBe('horizontal')
    expect(program!.export_layout!.columns[0].label).toBe('Movement')
  })

  it('leaves export_layout null for an unknown style id', async () => {
    const created = await createProgram({
      athlete_id: athleteId, name: 'No Style', export_style_id: '00000000-0000-0000-0000-000000000000',
    })
    const program = await findProgramById(created.id)
    expect(program!.export_layout).toBeNull()
  })

  it('copies export_layout from a source program via style_source_program_id', async () => {
    const source = await createProgram({
      athlete_id: athleteId, name: 'Source', export_style_id: (await createExportStyle('Src', TEMPLATE)).id,
    })
    const derived = await createProgram({
      athlete_id: athleteId, name: 'Derived', style_source_program_id: source.id,
    })
    const program = await findProgramById(derived.id)
    expect(program!.export_layout!.orientation).toBe('horizontal')
  })

  it('copies the original template bytes from a saved style onto a new program', async () => {
    const saved = await createExportStyle('Bytes Style', TEMPLATE, 'QkFTRTY0')
    const created = await createProgram({ athlete_id: athleteId, name: 'Bytes Program', export_style_id: saved.id })
    const program = await findProgramById(created.id)
    expect(program!.export_template_xlsx).toBe('QkFTRTY0')
  })

  it('renames a saved style', async () => {
    const saved = await createExportStyle('Old Name', TEMPLATE)
    expect(await renameExportStyle(saved.id, 'New Name')).toBe(true)
    const found = (await findAllExportStyles()).find((s) => s.id === saved.id)
    expect(found?.name).toBe('New Name')
  })

  it('returns false renaming an unknown style', async () => {
    expect(await renameExportStyle('00000000-0000-0000-0000-000000000000', 'X')).toBe(false)
  })

  it('deletes a saved style', async () => {
    const saved = await createExportStyle('Temp Style', TEMPLATE)
    expect(await deleteExportStyle(saved.id)).toBe(true)
    expect((await findAllExportStyles()).some((s) => s.id === saved.id)).toBe(false)
  })
})
