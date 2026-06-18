import { describe, it, expect } from 'vitest'
import { parseArchiveFilename } from './bulkImport'

describe('parseArchiveFilename', () => {
  it('splits "Athlete - Program.xlsx" on the first separator', () => {
    expect(parseArchiveFilename('John Smith - Block 2.xlsx')).toEqual({
      athleteName: 'John Smith',
      programName: 'Block 2',
    })
  })

  it('handles underscore separators and underscore-spaced names', () => {
    expect(parseArchiveFilename('Jane_-_Peaking_Block.xlsx')).toEqual({
      athleteName: 'Jane',
      programName: 'Peaking Block',
    })
  })

  it('uses only the first separator so program names may contain hyphens', () => {
    expect(parseArchiveFilename('Bob - Off-Season - Phase 1.xlsx')).toEqual({
      athleteName: 'Bob',
      programName: 'Off-Season - Phase 1',
    })
  })

  it('leaves athlete blank when there is no separator', () => {
    expect(parseArchiveFilename('squat_program.xlsx')).toEqual({
      athleteName: '',
      programName: 'squat program',
    })
  })

  it('strips folder paths from webkitRelativePath', () => {
    expect(parseArchiveFilename('archive/2024/Mia - Hypertrophy.xlsx')).toEqual({
      athleteName: 'Mia',
      programName: 'Hypertrophy',
    })
  })

  it('does not treat a leading separator as an empty athlete name', () => {
    expect(parseArchiveFilename('- mystery.xlsx')).toEqual({
      athleteName: '',
      programName: '- mystery',
    })
  })
})
