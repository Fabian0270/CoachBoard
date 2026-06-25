import { describe, it, expect, beforeAll } from 'vitest'
import ExcelJS from 'exceljs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseExternalFile } from './externalImportService.js'
import type { ExternalImportPreview } from 'coachboard-shared'

// ---------------------------------------------------------------------------
// Golden-file regression for the external-import parser (Feature 4a). The parser
// must DISCOVER the structure of arbitrary coach spreadsheets, so it's the part
// most likely to break on real, messy files. We pin its behaviour two ways:
//   • SYNTHETIC fixtures authored below, written to disk as real .xlsx + golden
//     .json, deliberately exercising the gnarly paths.
//   • Auto-discovery: any other .xlsx dropped in the fixtures dir is smoke-tested
//     (and golden-checked if a sidecar exists). See the fixtures README.
//
// Set UPDATE_FIXTURES=1 to (re)write the .xlsx and *.expected.json goldens after
// an intentional parser change — then review the JSON diff before committing.
// ---------------------------------------------------------------------------

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'external-import',
)
const UPDATE = !!process.env.UPDATE_FIXTURES

type Cell = string | number | null

/** Build an xlsx buffer from a 2-D grid; optional A1-style merge ranges. */
async function buildSheet(rows: Cell[][], merges: string[] = []): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  rows.forEach((row, r) => {
    row.forEach((val, c) => {
      if (val !== null && val !== undefined && val !== '') {
        ws.getCell(r + 1, c + 1).value = val
      }
    })
  })
  for (const range of merges) ws.mergeCells(range)
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer)
}

// Reduce a preview to the stable, human-meaningful fields we want to regress on.
// Drops the captured layoutTemplate (colors/fonts — ExcelJS-version sensitive) and
// any server-internal column indices.
function golden(p: ExternalImportPreview) {
  return {
    layout: p.layout,
    columnMapping: p.columnMapping,
    weeks: p.weeks,
    days: p.days,
    exerciseCount: p.exerciseCount,
    suggestedFocus: p.suggestedFocus,
    errors: p.errors,
    warnings: p.warnings.map((w) => w.message),
    exercises: p.exercises.map((e) => ({
      weekIndex: e.weekIndex,
      dayIndex: e.dayIndex,
      weekLabel: e.weekLabel,
      dayLabel: e.dayLabel,
      name: e.name,
      sets: e.sets,
      reps: e.reps,
      load: e.load,
      rpe: e.rpe,
    })),
  }
}

const HEADER = ['Exercise', 'Sets', 'Reps', 'Load', 'RPE']

// Each fixture targets specific parser hazards; see the inline note.
const SYNTHETIC: { name: string; note: string; rows: Cell[][]; merges?: string[] }[] = [
  {
    name: 'merged-banners-units-swedish',
    note: 'merged week banners, a title row above the header, units in load cells, Swedish-decimal load',
    rows: [
      ['Coach X — Strength Block'],
      HEADER,
      ['Week 1'],
      ['Day 1'],
      ['Back Squat', 3, 5, '100 kg', 8],
      ['Bench Press', '3', '5', '82,5', '7.5'],
      ['Day 2'],
      ['Deadlift', 1, 5, '140kg', 9],
      ['Week 2'],
      ['Day 1'],
      ['Back Squat', 3, 5, '105 kg', 8],
    ],
    merges: ['A3:E3', 'A9:E9'],
  },
  {
    name: 'rir-ranges-amrap',
    note: 'RIR column (→RPE), rep ranges, AMRAP reps, RIR 0 → RPE 10',
    rows: [
      ['Movement', 'Set', 'Reps', 'Weight', 'RIR'],
      ['Week 1'],
      ['Day 1'],
      ['Squat', 4, '6-10', 100, 2],
      ['Bench', 3, 'AMRAP', 60, 3],
      ['Day 2'],
      ['Deadlift', 1, 3, 140, 0],
    ],
  },
  {
    name: 'bodyweight-and-bad-load',
    note: 'bodyweight rows (load→null), an unreadable load cell (→warning + blank)',
    rows: [
      HEADER,
      ['Week 1'],
      ['Day 1'],
      ['Pull-up', 3, 8, 'BW', 8],
      ['Squat', 5, 3, '85%', 8],
      ['Dip', 3, 10, 'bodyweight', 7],
    ],
  },
  {
    name: 'coachboard-style-offset-weekday',
    note: 'title+blank rows before header, CoachBoard aliases (rpe must not be stolen by sets), W1 week, weekday day-labels',
    rows: [
      ['CoachBoard Program Export'],
      [],
      ['Discipline', 'Sets', 'Reps', 'Load Used', 'Last Set RPE'],
      ['W1'],
      ['Mon'],
      ['Squat', 3, 5, 100, 8],
      ['Tue'],
      ['Bench', 3, 8, 60, 7],
    ],
  },
  {
    name: 'swedish-headers-and-sections',
    note: 'Swedish column headers (Övning/Serie/Repetitioner/Vikt), Vecka weeks, weekday days (Måndag/Torsdag), Swedish decimal, KV bodyweight',
    rows: [
      ['Övning', 'Serie', 'Repetitioner', 'Vikt', 'RPE'],
      ['Vecka 1'],
      ['Måndag'],
      ['Knäböj', 3, 5, '100 kg', 8],
      ['Bänkpress', 3, 5, '82,5', 7.5],
      ['Torsdag'],
      ['Marklyft', 1, 5, 140, 9],
      ['Vecka 2'],
      ['Måndag'],
      ['Knäböj', 3, 5, 105, 8],
      ['Chins', 3, 8, 'KV', 8],
    ],
  },
  {
    name: 'minimal-with-trailing-blanks',
    note: 'single week/day, trailing empty rows that must not become phantom exercises',
    rows: [
      HEADER,
      ['Week 1'],
      ['Day 1'],
      ['Squat', 3, 5, 120, 8],
      [],
      [],
      [],
    ],
  },
]

beforeAll(async () => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true })
  for (const fx of SYNTHETIC) {
    const file = path.join(FIXTURE_DIR, `${fx.name}.xlsx`)
    if (UPDATE || !fs.existsSync(file)) {
      fs.writeFileSync(file, await buildSheet(fx.rows, fx.merges))
    }
  }
})

describe('external-import parser — synthetic golden fixtures', () => {
  for (const fx of SYNTHETIC) {
    it(`parses "${fx.name}" to its golden output (${fx.note})`, async () => {
      const buf = fs.readFileSync(path.join(FIXTURE_DIR, `${fx.name}.xlsx`))
      const got = golden(await parseExternalFile(buf))

      const goldenPath = path.join(FIXTURE_DIR, `${fx.name}.expected.json`)
      if (UPDATE || !fs.existsSync(goldenPath)) {
        fs.writeFileSync(goldenPath, `${JSON.stringify(got, null, 2)}\n`)
      }
      const expected = JSON.parse(fs.readFileSync(goldenPath, 'utf8'))

      // Sanity: every synthetic fixture is a real, importable program.
      expect(got.errors).toEqual([])
      expect(got.exerciseCount).toBeGreaterThan(0)
      // Regression: parse output must match the committed golden.
      expect(got).toEqual(expected)
    })
  }
})

// Any .xlsx in the fixtures dir that isn't a synthetic fixture is treated as a
// real coach file the dev dropped in. We don't know its expected output, so we
// smoke-test that the parser handles it; if a *.expected.json sidecar exists, we
// golden-check it too.
const synthFiles = new Set(SYNTHETIC.map((f) => `${f.name}.xlsx`))
const droppedFiles = fs.existsSync(FIXTURE_DIR)
  ? fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.xlsx') && !synthFiles.has(f))
  : []

describe('external-import parser — dropped real coach files', () => {
  if (droppedFiles.length === 0) {
    it.skip('no real coach files in __fixtures__/external-import (drop a .xlsx to add one)', () => {})
    return
  }
  for (const f of droppedFiles) {
    it(`parses "${f}" without crashing and finds exercises`, async () => {
      const buf = fs.readFileSync(path.join(FIXTURE_DIR, f))
      const res = await parseExternalFile(buf)

      expect(Array.isArray(res.exercises)).toBe(true)
      // A real program file should yield exercises; if not, that's the bug we want surfaced.
      expect(res.exerciseCount).toBeGreaterThan(0)

      const goldenPath = path.join(FIXTURE_DIR, f.replace(/\.xlsx$/, '.expected.json'))
      if (UPDATE) {
        fs.writeFileSync(goldenPath, `${JSON.stringify(golden(res), null, 2)}\n`)
      } else if (fs.existsSync(goldenPath)) {
        expect(golden(res)).toEqual(JSON.parse(fs.readFileSync(goldenPath, 'utf8')))
      }
    })
  }
})
