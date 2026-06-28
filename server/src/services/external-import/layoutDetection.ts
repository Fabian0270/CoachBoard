import { tokenize } from './cellParsing.js'
import { ALIASES } from './headerDetection.js'
import type { ReadRow } from './shared.js'

// ---------------------------------------------------------------------------
// Layout detection — sniff the worksheet's overall shape (vertical vs. the three
// horizontal "week block" variants) before dispatching to a layout parser.
// ---------------------------------------------------------------------------

const WEEK_BANNER = /^(week|w)\s*\d+$/i

/**
 * A row holding ≥2 *distinct* "Week N" banners marks a horizontal layout.
 * Dedupe by label text: a merged single banner ("Week 1" spanning columns)
 * reads as the same value repeated and must NOT be mistaken for multiple weeks.
 */
export function findWeekBannerRow(readRow: ReadRow, maxRow: number): { row: number; weekCols: number[] } | null {
  const scan = Math.min(maxRow, 15)
  for (let r = 1; r <= scan; r++) {
    const cells = readRow(r)
    const firstColByLabel = new Map<string, number>()
    for (let c = 0; c < cells.length; c++) {
      const text = cells[c].trim()
      if (WEEK_BANNER.test(text)) {
        const key = text.toLowerCase()
        if (!firstColByLabel.has(key)) firstColByLabel.set(key, c + 1)
      }
    }
    if (firstColByLabel.size >= 2) {
      return { row: r, weekCols: [...firstColByLabel.values()].sort((a, b) => a - b) }
    }
  }
  return null
}

export const DAY_LABEL = /^day\s*(\d+)/i

/**
 * A block-grid sheet is a week-banner sheet whose blocks each begin with a
 * "DAY n" column one to the LEFT of the "Week n" banner. Returns the 1-based
 * block-start columns when the majority of weeks show that DAY-then-Week shape.
 */
export function detectBlockGridStarts(readRow: ReadRow, banner: { row: number; weekCols: number[] }): number[] | null {
  const cells = readRow(banner.row)
  const starts: number[] = []
  let dayHits = 0
  for (const wc of banner.weekCols) {
    const left = (cells[wc - 2] ?? '').trim() // cell immediately left of the banner
    if (DAY_LABEL.test(left)) {
      starts.push(wc - 1)
      dayHits++
    } else {
      starts.push(wc)
    }
  }
  return dayHits >= Math.ceil(banner.weekCols.length / 2) ? starts : null
}

/**
 * A week-grid sheet is a week-banner sheet (not block-grid) whose data columns
 * begin AT each "Week N" banner — the cell on the banner column is a "Set"
 * header — with a non-name lead column one to the left holding day/movement
 * labels. Returns the lead-column block starts and the single header row.
 *
 * The lead column header must NOT be an exercise-name alias: that shape is the
 * horizontal "shared name column" layout (a dedicated "Discipline" column left
 * of the blocks), which parseHorizontal already handles.
 */
export function detectWeekGrid(
  readRow: ReadRow,
  maxRow: number,
  banner: { row: number; weekCols: number[] },
): { blockStarts: number[]; headerRow: number } | null {
  if (banner.weekCols[0] < 2) return null // no room for a lead column
  const blockStarts = banner.weekCols.map((c) => c - 1)
  const blockWidth = blockStarts.length >= 2 ? blockStarts[1] - blockStarts[0] : 8
  const limit = Math.min(maxRow, banner.row + 8)
  for (let r = banner.row; r <= limit; r++) {
    const cells = readRow(r)
    const atBanner = tokenize(cells[banner.weekCols[0] - 1] ?? '')
    // A dedicated exercise-name column (e.g. "Discipline") at OR to the left of
    // the lead column is the signature of the horizontal "shared name column"
    // layout, which parseHorizontal already handles. A real week-grid has no
    // separate name column — its lead column holds the movement names under a
    // weekday header — so bail out and let the horizontal parser run instead.
    let hasNameColumn = false
    for (let c = 0; c < blockStarts[0]; c++) {
      if (tokenize(cells[c] ?? '').some((t) => ALIASES.exercise.includes(t))) { hasNameColumn = true; break }
    }
    if (hasNameColumn) return null
    const block = cells.slice(blockStarts[0] - 1, blockStarts[0] - 1 + blockWidth).join(' ').toLowerCase()
    if (atBanner.some((t) => t === 'set' || t === 'sets') && /\brep/.test(block)) {
      return { blockStarts, headerRow: r }
    }
  }
  return null
}
