import ExcelJS from 'exceljs'
import { buildProgramWorkbook } from './programExport.js'

// ---------------------------------------------------------------------------
// Workbook → HTML preview.
//
// Reads back the *actual generated .xlsx buffer* (the exact bytes that get
// downloaded or emailed, scaffold path included) and renders its first sheet
// to a styled HTML table. Going through the real file rather than re-deriving
// the layout means the preview can never drift from what the athlete receives.
//
// Only the visual properties that matter for "does this look right" are
// carried over: fills, bold/italic, font color, alignment, merged cells and
// column widths.
// ---------------------------------------------------------------------------

const DEFAULT_COL_WIDTH = 9 // Excel width units, roughly a default column

/** ARGB ("FFB39DDB") or RGB → CSS "#RRGGBB". Returns null when unusable. */
function argbToCss(argb: string | undefined): string | null {
  if (!argb) return null
  const hex = argb.length === 8 ? argb.slice(2) : argb
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null
  return `#${hex}`
}

/** Excel column-width units → approximate pixels. */
function widthToPx(width: number | undefined): number {
  return Math.round((width ?? DEFAULT_COL_WIDTH) * 7) + 5
}

function colLettersToNumber(letters: string): number {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

interface MergeInfo {
  rowspan: number
  colspan: number
}

/** Parse "A1:C2" merge ranges → master-cell spans + the set of covered cells. */
function parseMerges(merges: string[]): {
  masters: Map<string, MergeInfo>
  covered: Set<string>
} {
  const masters = new Map<string, MergeInfo>()
  const covered = new Set<string>()
  for (const range of merges) {
    const [start, end] = range.split(':')
    const m1 = /^([A-Z]+)(\d+)$/.exec(start)
    const m2 = /^([A-Z]+)(\d+)$/.exec(end)
    if (!m1 || !m2) continue
    const c1 = colLettersToNumber(m1[1])
    const r1 = Number(m1[2])
    const c2 = colLettersToNumber(m2[1])
    const r2 = Number(m2[2])
    masters.set(`${r1},${c1}`, { rowspan: r2 - r1 + 1, colspan: c2 - c1 + 1 })
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (r === r1 && c === c1) continue
        covered.add(`${r},${c}`)
      }
    }
  }
  return { masters, covered }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Render the first worksheet of an .xlsx buffer to a standalone HTML table. */
export async function renderWorkbookHtml(buffer: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  const ws = wb.worksheets[0]
  if (!ws) return '<table class="xlsx-preview"></table>'

  const colCount = Math.max(ws.columnCount, ws.actualColumnCount, 1)
  const rowCount = Math.max(ws.rowCount, ws.actualRowCount, 1)
  const { masters, covered } = parseMerges((ws.model.merges as string[]) ?? [])

  const colGroup: string[] = []
  for (let c = 1; c <= colCount; c++) {
    colGroup.push(`<col style="width:${widthToPx(ws.getColumn(c).width)}px" />`)
  }

  const rows: string[] = []
  for (let r = 1; r <= rowCount; r++) {
    const cells: string[] = []
    for (let c = 1; c <= colCount; c++) {
      const key = `${r},${c}`
      if (covered.has(key)) continue
      const cell = ws.getCell(r, c)
      const span = masters.get(key)
      const styles: string[] = []

      const fill = cell.fill as ExcelJS.FillPattern | undefined
      const bg = fill?.type === 'pattern' ? argbToCss(fill.fgColor?.argb) : null
      if (bg) styles.push(`background:${bg}`)

      const font = cell.font
      if (font?.bold) styles.push('font-weight:600')
      if (font?.italic) styles.push('font-style:italic')
      const fontColor = argbToCss(font?.color?.argb)
      if (fontColor) styles.push(`color:${fontColor}`)

      const align = cell.alignment?.horizontal
      if (align) styles.push(`text-align:${align}`)

      const spanAttr = span ? ` rowspan="${span.rowspan}" colspan="${span.colspan}"` : ''
      const text = escapeHtml(cell.text ?? '')
      cells.push(`<td${spanAttr} style="${styles.join(';')}">${text}</td>`)
    }
    rows.push(`<tr>${cells.join('')}</tr>`)
  }

  return (
    `<table class="xlsx-preview"><colgroup>${colGroup.join('')}</colgroup>` +
    `<tbody>${rows.join('')}</tbody></table>`
  )
}

/** Build a program's workbook and return its HTML preview (shares the export path). */
export async function buildProgramPreviewHtml(programId: string): Promise<string> {
  const { buffer } = await buildProgramWorkbook(programId)
  return renderWorkbookHtml(buffer)
}
