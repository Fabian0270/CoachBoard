import { describe, it, expect } from 'vitest'
import { isCellBlock, parseCellBlock, rowToFields } from './pasteGrid'
import type { ColKey } from './programUtils'

const cols: ColKey[] = ['name', 'rest_time', 'sets', 'reps', 'intensity', 'load_cap', 'load_used', 'rpe']

describe('isCellBlock', () => {
  it('knows a range copied from a spreadsheet', () => {
    expect(isCellBlock('Squat\t5\t5\r\nBench\t4\t6\r\n')).toBe(true)
    expect(isCellBlock('Squat\t5')).toBe(true)
    // One column of several rows: Excel ends it with a line break.
    expect(isCellBlock('Squat\r\nBench\r\nRows\r\n')).toBe(true)
  })
  it('leaves ordinary text for one cell alone', () => {
    expect(isCellBlock('Pause Squat')).toBe(false)
    expect(isCellBlock('brace\nthen breathe')).toBe(false)
  })
})

describe('parseCellBlock', () => {
  it('splits rows and cells, trims, drops the trailing line, unquotes', () => {
    expect(parseCellBlock('Squat\t 5 \t5\r\n"Bench, paused"\t4\t6\r\n\r\n')).toEqual([
      ['Squat', '5', '5'],
      ['Bench, paused', '4', '6'],
    ])
  })
})

describe('rowToFields', () => {
  it('reads across the columns on screen from where it was pasted', () => {
    expect(rowToFields(['Squat', '3', '5', '5', 'RPE 8', '140'], cols, 'name').fields).toEqual({
      name: 'Squat', rest_time: '3', sets: '5', reps: '5', intensity: 'RPE 8', weight: 140,
    })
    // Pasted into Sets: the first cell is Sets.
    expect(rowToFields(['4', '6'], cols, 'sets').fields).toEqual({ sets: '4', reps: '6' })
  })
  it('takes a decimal comma and "kg" in Load Cap, and counts what is not a number', () => {
    expect(rowToFields(['102,5 kg'], cols, 'load_cap').fields).toEqual({ weight: 102.5 })
    const r = rowToFields(['heavy'], cols, 'load_cap')
    expect(r.fields).toEqual({})
    expect(r.notNumbers).toBe(1)
  })
  it('counts cells past the last column', () => {
    expect(rowToFields(['8', 'x', 'y'], cols, 'rpe').ignored).toBe(2)
  })
})
