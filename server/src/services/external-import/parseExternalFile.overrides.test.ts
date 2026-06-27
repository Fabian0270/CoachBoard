import { describe, it, expect } from 'vitest'
import { parseExternalFile } from '../externalImportService.js'
import { buildSheet } from './__testutils__/buildSheet.js'

// ---------------------------------------------------------------------------
// Manual column / header overrides (Layer 2 — the wizard's correction safety net)
// ---------------------------------------------------------------------------
describe('parseExternalFile — manual overrides', () => {
  // Headers that match none of the aliases, so auto-detection can't map them.
  const cryptic = [
    ['Mov', 'S', 'R', 'Kg', 'Effrt'],
    ['Squat', 3, 5, 100, 8],
    ['Bench', 3, 8, 60, 7],
  ]

  it('surfaces header row, cells and column count so the wizard can remap', async () => {
    const res = await parseExternalFile(await buildSheet(cryptic))
    // Exercise/Sets/Reps unrecognised → not importable as-is…
    expect(res.errors.length).toBeGreaterThan(0)
    expect(res.exerciseCount).toBe(0)
    // …but the header info needed to remap is provided.
    expect(res.headerRowIndex).toBe(1)
    expect(res.headerCells.slice(0, 5)).toEqual(['Mov', 'S', 'R', 'Kg', 'Effrt'])
    expect(res.columnCount).toBeGreaterThanOrEqual(5)
  })

  it('imports once the coach pins the columns manually', async () => {
    const res = await parseExternalFile(await buildSheet(cryptic), {
      exercise: 1, sets: 2, reps: 3, load: 4, rpe: 5,
    })
    expect(res.errors).toEqual([])
    expect(res.exerciseCount).toBe(2)
    expect(res.exercises[0]).toMatchObject({ name: 'Squat', sets: '3', reps: '5', load: '100', rpe: '8' })
  })

  it('clears a wrongly-detected column when overridden to null', async () => {
    const res = await parseExternalFile(await buildSheet([
      ['Exercise', 'Sets', 'Reps', 'Load', 'RPE'],
      ['Squat', 3, 5, 100, 8],
    ]), { load: null })
    expect(res.errors).toEqual([])
    expect(res.columnMapping.load).toBeNull()
    expect(res.exercises[0].load).toBeNull()
    expect(res.warnings.some((w) => /Load/i.test(w.message))).toBe(true)
  })

  it('honours a forced header row', async () => {
    const res = await parseExternalFile(await buildSheet([
      ['My Program'],
      [],
      ['Exercise', 'Sets', 'Reps', 'Load', 'RPE'],
      ['Squat', 3, 5, 100, 8],
    ]), { headerRow: 3 })
    expect(res.errors).toEqual([])
    expect(res.headerRowIndex).toBe(3)
    expect(res.exerciseCount).toBe(1)
  })

  it('treats the RPE column as RIR when rpeFromRir is set', async () => {
    // A header that reads "RPE" but actually holds RIR values; coach flags it.
    const res = await parseExternalFile(await buildSheet([
      ['Exercise', 'Sets', 'Reps', 'Load', 'RPE'],
      ['Squat', 3, 5, 100, 2],
    ]), { rpeFromRir: true })
    expect(res.columnMapping.rpeFromRir).toBe(true)
    expect(res.exercises[0].rpe).toBe('8') // RIR 2 → RPE 8
  })
})
