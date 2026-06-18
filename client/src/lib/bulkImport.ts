// Helpers for the bulk / folder import flow (Feature 4d).

export interface ParsedArchiveName {
  athleteName: string   // '' when no athlete prefix could be detected
  programName: string
}

// Separators a coach might use between an athlete name and the program name in
// a filename, e.g. "John Smith - Block 2.xlsx" or "Jane_-_Peaking.xlsx".
const SEPARATORS = [' - ', ' – ', ' — ', '_-_', ' _ ']

/**
 * Split an uploaded filename into a best-guess athlete name and program name.
 * Convention: text before the first separator is the athlete; the rest is the
 * program. With no separator the whole stem becomes the program name and the
 * athlete is left blank for the coach to assign. Always reassignable in the UI.
 */
export function parseArchiveFilename(filename: string): ParsedArchiveName {
  // Strip path (webkitRelativePath uses '/') and the .xlsx/.xls extension.
  const base = filename.split(/[\\/]/).pop() ?? filename
  const stem = base.replace(/\.(xlsx|xls)$/i, '').trim()

  for (const sep of SEPARATORS) {
    const idx = stem.indexOf(sep)
    if (idx > 0) {
      const athleteName = stem.slice(0, idx).trim()
      const programName = stem.slice(idx + sep.length).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim()
      if (athleteName && programName) return { athleteName, programName }
    }
  }

  return { athleteName: '', programName: stem.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() }
}
