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
  notes: [
    'notes', 'note', 'cue', 'cues', 'comment', 'comments', 'instructions', 'instruction',
    'kommentar', 'kommentarer', 'anteckning', 'anteckningar', 'notering', 'noteringar',
    'instruktion', 'instruktioner',
  ],
}
const RIR_ALIASES = ['rir']

/**
 * Header words that mark a column as what the ATHLETE did rather than what the
 * coach prescribed: "Load used", "Last set RPE", "Actual RPE", "Faktisk vikt".
 *
 * Load Used and Last Set RPE are only ever filled in by the athlete. A coach's
 * sheet with a plain "Load" or "RPE" column is the prescription, and storing it
 * as results made a fresh plan read as completed, with 1RM estimates computed
 * from weights nobody had lifted yet.
 */
const RESULT_WORDS = ['used', 'actual', 'done', 'achieved', 'last', 'faktisk', 'faktiskt', 'gjord', 'gjort', 'senaste', 'utförd']

export function isResultHeader(text: string): boolean {
  return tokenize(text).some((t) => RESULT_WORDS.includes(t))
}

/** Words that make a comments column the athlete's: "Athlete comments", "Feedback", "Comments after". */
const ATHLETE_WORDS = [
  'athlete', 'athletes', 'client', 'feedback', 'after',
  'atlet', 'atletens', 'adept', 'återkoppling', 'efter',
]

/**
 * Whether a header is the coach's notes / comments / cues column.
 *
 * Its text becomes the cue the athlete reads, so a column the athlete writes in
 * ("Athlete comments", "Feedback", "Comments after") is never taken for one.
 */
export function isCueHeader(text: string): boolean {
  const tokens = tokenize(text)
  return tokens.some((t) => ALIASES.notes.includes(t)) &&
    !tokens.some((t) => RESULT_WORDS.includes(t) || ATHLETE_WORDS.includes(t))
}

// Keys resolved in this order so a more specific header wins a shared token.
// e.g. "Last Set RPE" tokenises to [last, set, rpe]; resolving rpe before sets
// claims that column for rpe, leaving a plain "Sets" column free for sets.
// Notes go last, so a header naming a field ("Load notes") stays that field.
const RESOLVE_ORDER: ExternalColumnKey[] = ['exercise', 'rpe', 'reps', 'sets', 'load', 'notes']

export interface ResolvedHeader {
  mapping: ExternalColumnMapping
  matchCount: number
}

/** Assign worksheet columns to field keys for one candidate header row. */
export function resolveHeaderRow(cellTexts: string[]): ResolvedHeader {
  const tokensByCol = cellTexts.map(tokenize)
  const claimed = new Set<number>()
  const mapping: ExternalColumnMapping = {
    exercise: null, sets: null, reps: null, load: null, rpe: null, notes: null, rpeFromRir: false,
  }

  for (const key of RESOLVE_ORDER) {
    const aliases = key === 'rpe' ? [...ALIASES.rpe, ...RIR_ALIASES] : ALIASES[key]
    for (let c = 0; c < tokensByCol.length; c++) {
      if (claimed.has(c)) continue
      if (key === 'notes' && !isCueHeader(cellTexts[c] ?? '')) continue
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

  // Notes never count toward picking the header row: a row of free text that
  // says "Notes" must not outrank the real Exercise/Sets/Reps row.
  const matchCount = (['exercise', 'sets', 'reps', 'load', 'rpe'] as const)
    .filter((k) => mapping[k] !== null).length
  return { mapping, matchCount }
}
