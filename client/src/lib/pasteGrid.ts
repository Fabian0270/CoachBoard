import type { ColKey } from './programUtils'

// ---------------------------------------------------------------------------
// Rows pasted from a spreadsheet into the day editor.
//
// Excel, Numbers and Google Sheets all put a copied range on the clipboard as
// tab-separated cells, one line per row, ending with a line break. The day
// editor reads such a block the way a spreadsheet would: from the cell it was
// pasted into, left to right across the columns as they are on screen, and
// down into new rows.
// ---------------------------------------------------------------------------

export interface PastedFields {
  name?: string
  sets?: string | null
  reps?: string | null
  weight?: number | null
  rest_time?: string | null
  intensity?: string | null
  load_used?: string | null
  rpe?: string | null
}

/**
 * Whether pasted text is a block of cells rather than text for one cell.
 * A tab means cells. Several lines with a trailing line break is how a
 * spreadsheet copies one column; ordinary multi-line text does not end that way.
 */
export function isCellBlock(text: string): boolean {
  if (text.includes('\t')) return true
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  return lines.length > 2 && lines[lines.length - 1] === '' && lines.slice(0, -1).every((l) => !l.includes('\n'))
}

/** The block as rows of cells. Trailing empty lines are dropped; a quoted cell loses its quotes. */
export function parseCellBlock(text: string): string[][] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.map((line) => line.split('\t').map((c) => c.trim().replace(/^"(.*)"$/s, '$1').trim()))
}

/** A Load Cap from a cell: "102,5", "102.5 kg". Null for empty; NaN for anything else. */
function parseLoad(cell: string): number | null {
  const t = cell.replace(/\s*kg$/i, '').replace(',', '.').trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : NaN
}

/**
 * The fields one pasted row fills, reading its cells into `columns` from
 * `start` on. Cells past the last column are ignored. `notNumbers` counts
 * Load Cap cells that were not a number and so were left out.
 */
export function rowToFields(cells: string[], columns: ColKey[], start: ColKey): { fields: PastedFields; notNumbers: number; ignored: number } {
  const from = Math.max(0, columns.indexOf(start))
  const fields: PastedFields = {}
  let notNumbers = 0
  cells.forEach((cell, i) => {
    const col = columns[from + i]
    if (!col) return
    if (col === 'load_cap') {
      const n = parseLoad(cell)
      if (Number.isNaN(n)) { notNumbers++; return }
      fields.weight = n
    } else if (col === 'name') {
      fields.name = cell
    } else {
      fields[col] = cell === '' ? null : cell
    }
  })
  return { fields, notNumbers, ignored: Math.max(0, cells.length - (columns.length - from)) }
}
