import type ExcelJS from 'exceljs'
import type {
  ExternalColumnKey,
  ExternalColumnMapping,
  ExternalExerciseRow,
  ExportLayoutTemplate,
} from 'coachboard-shared'
import {
  COLUMN_LABELS,
  type ExportColumnKey,
  type ExportLayoutColumn,
} from 'coachboard-shared/exportLayout'
import { cellToString } from './cellParsing.js'
import { weekdayOffset } from './valueNormalizers.js'

// ---------------------------------------------------------------------------
// Layout template capture — read the uploaded file's styling + structure into
// an ExportLayoutTemplate so any program based on this import re-exports in the
// coach's own look (colors, fonts, orientation, day labels) rather than
// CoachBoard's generic style. Sampled from representative cells located via the
// detection results (header row, banner cell, first data row).
// ---------------------------------------------------------------------------

/** Solid-fill ARGB at a cell, or null (theme fills / no fill / out of range → null). */
function cellFillArgb(ws: ExcelJS.Worksheet, row: number, col: number): string | null {
  if (row < 1 || col < 1) return null
  const fill = ws.getCell(row, col).fill as ExcelJS.Fill | undefined
  if (fill && fill.type === 'pattern' && fill.pattern === 'solid') {
    const argb = (fill as ExcelJS.FillPattern).fgColor?.argb
    if (typeof argb === 'string') return argb
  }
  return null
}

function cellFont(ws: ExcelJS.Worksheet, row: number, col: number): Partial<ExcelJS.Font> {
  if (row < 1 || col < 1) return {}
  return ws.getCell(row, col).font ?? {}
}

const EXTERNAL_TO_EXPORT_KEY: Record<ExternalColumnKey, ExportColumnKey> = {
  exercise: 'name', sets: 'sets', reps: 'reps', load: 'load_used', rpe: 'rpe',
}

/** Distinctly-Swedish weekday prefixes (accented + ASCII-safe forms). */
const SV_DAY_MARKERS = ['mån', 'man', 'tis', 'ons', 'tor', 'fre', 'lör', 'lor', 'sön', 'son']

export function captureLayoutTemplate(
  ws: ExcelJS.Worksheet,
  info: {
    orientation: ExportLayoutTemplate['orientation']
    columnMapping: ExternalColumnMapping
    exercises: ExternalExerciseRow[]
    headerRow?: number
    bannerRow: number | null
    bannerCol: number | null
  },
): ExportLayoutTemplate {
  const { orientation, columnMapping, exercises, headerRow, bannerRow, bannerCol } = info
  const nameCol = columnMapping.exercise
  const rpeCol = columnMapping.rpe
  const bodyRow = exercises[0]?.sheetRow ?? null

  // --- columns + the coach's own header wording ---
  const columns: ExportLayoutColumn[] = []
  for (const extKey of ['exercise', 'sets', 'reps', 'load', 'rpe'] as ExternalColumnKey[]) {
    const colIdx = columnMapping[extKey]
    if (typeof colIdx !== 'number') continue
    const expKey = EXTERNAL_TO_EXPORT_KEY[extKey]
    const headerText = headerRow ? cellToString(ws.getCell(headerRow, colIdx).value) : ''
    columns.push({ key: expKey, label: headerText || COLUMN_LABELS[expKey] })
  }

  // --- day labels + language (from the detected day-section labels) ---
  const labelByDay = new Map<number, string>()
  for (const ex of exercises) {
    if (!labelByDay.has(ex.dayIndex) && ex.dayLabel) labelByDay.set(ex.dayIndex, ex.dayLabel)
  }
  let sawWeekday = false
  let sawDayN = false
  let language: 'en' | 'sv' = 'en'
  for (const label of labelByDay.values()) {
    if (/^day\s*\d+/i.test(label)) sawDayN = true
    else if (weekdayOffset(label) !== null) sawWeekday = true
    if (SV_DAY_MARKERS.some((m) => label.toLowerCase().startsWith(m))) language = 'sv'
  }
  const dayStyle: ExportLayoutTemplate['dayLabels']['style'] =
    sawWeekday ? 'weekday' : sawDayN ? 'dayN' : 'split'
  const maxDay = labelByDay.size ? Math.max(...labelByDay.keys()) : -1
  const custom: (string | null)[] = []
  for (let i = 0; i <= maxDay; i++) custom[i] = labelByDay.get(i) ?? null

  // --- RPE notation: a leading "@" in the source RPE cell ("@8") ---
  let rpeNotation: ExportLayoutTemplate['rpeNotation'] = 'plain'
  if (typeof rpeCol === 'number') {
    for (const ex of exercises.slice(0, 20)) {
      if (cellToString(ws.getCell(ex.sheetRow, rpeCol).value).startsWith('@')) {
        rpeNotation = 'at'
        break
      }
    }
  }

  // --- colors + fonts sampled from representative cells ---
  const headerFont = headerRow && nameCol ? cellFont(ws, headerRow, nameCol) : {}
  const columnHeader = headerRow && nameCol ? cellFillArgb(ws, headerRow, nameCol) : null
  return {
    version: 1,
    orientation,
    columns,
    dayLabels: { style: dayStyle, language, custom },
    rpeNotation,
    colors: {
      weekBanner: bannerRow && bannerCol ? cellFillArgb(ws, bannerRow, bannerCol) : columnHeader,
      dayHeader: headerRow ? cellFillArgb(ws, headerRow, 1) : null,
      columnHeader,
      trackingHeader: headerRow && typeof rpeCol === 'number' ? cellFillArgb(ws, headerRow, rpeCol) : null,
      body: bodyRow && nameCol ? cellFillArgb(ws, bodyRow, nameCol) : null,
    },
    fonts: {
      headerBold: !!headerFont.bold,
      headerItalic: !!headerFont.italic,
      nameBold: bodyRow && nameCol ? !!cellFont(ws, bodyRow, nameCol).bold : false,
    },
  }
}
