import type { ExternalColumnKey, ExternalColumnMapping } from 'coachboard-shared'
import { tokenize } from './cellParsing.js'

// ---------------------------------------------------------------------------
// Header detection — map an arbitrary worksheet's columns to known field keys.
// ---------------------------------------------------------------------------

// Header aliases, English + Swedish (the primary user base). Tokens are matched
// case-insensitively against tokenised header cells, so each entry is a single
// lowercased word (see tokenize, which preserves å/ä/ö).
export const ALIASES: Record<ExternalColumnKey, string[]> = {
  exercise: ['exercise', 'movement', 'lift', 'name', 'discipline', 'övning', 'övningar', 'rörelse'],
  sets: ['sets', 'set', 'serie', 'serier'],
  reps: ['reps', 'rep', 'repetitions', 'repetition', 'repetitioner'],
  load: ['load', 'weight', 'kg', 'lbs', 'lb', 'intensity', 'intensitet', 'vikt', 'belastning', 'kilo'],
  rpe: ['rpe', 'effort', 'ansträngning'],
}
const RIR_ALIASES = ['rir']

// Keys resolved in this order so a more specific header wins a shared token.
// e.g. "Last Set RPE" tokenises to [last, set, rpe]; resolving rpe before sets
// claims that column for rpe, leaving a plain "Sets" column free for sets.
const RESOLVE_ORDER: ExternalColumnKey[] = ['exercise', 'rpe', 'reps', 'sets', 'load']

export interface ResolvedHeader {
  mapping: ExternalColumnMapping
  matchCount: number
}

/** Assign worksheet columns to field keys for one candidate header row. */
export function resolveHeaderRow(cellTexts: string[]): ResolvedHeader {
  const tokensByCol = cellTexts.map(tokenize)
  const claimed = new Set<number>()
  const mapping: ExternalColumnMapping = {
    exercise: null, sets: null, reps: null, load: null, rpe: null, rpeFromRir: false,
  }

  for (const key of RESOLVE_ORDER) {
    const aliases = key === 'rpe' ? [...ALIASES.rpe, ...RIR_ALIASES] : ALIASES[key]
    for (let c = 0; c < tokensByCol.length; c++) {
      if (claimed.has(c)) continue
      const tokens = tokensByCol[c]
      const hit = tokens.find((t) => aliases.includes(t))
      if (hit) {
        mapping[key] = c + 1 // 1-based column index
        claimed.add(c)
        if (key === 'rpe' && RIR_ALIASES.includes(hit)) mapping.rpeFromRir = true
        break
      }
    }
  }

  const matchCount = (['exercise', 'sets', 'reps', 'load', 'rpe'] as const)
    .filter((k) => mapping[k] !== null).length
  return { mapping, matchCount }
}
