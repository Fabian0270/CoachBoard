import type { ParsedCaption } from 'coachboard-shared/discord'

// ---------------------------------------------------------------------------
// Caption parsing + workout suggestion scoring.
//
// Athletes caption their form-check videos with things like "180 kg for 2",
// "bänk 80x5 @8" — we parse load/reps/RPE/lift keywords and use them together
// with the post date to pick which workout (and thereby which program) the
// video belongs to. Pure functions, no I/O. The result is always a SUGGESTION
// the coach confirms — never an automatic attachment (support, never override).
// ---------------------------------------------------------------------------

const LBS_TO_KG = 0.45359237

// "180 kg for 2", "180x2", "80 kg x 5", "180*2", Swedish "180 för 2".
const LOAD_REPS_RE = /(\d+(?:[.,]\d+)?)\s*(kg|lbs?)?\s*(?:x|×|\*|for|för)\s*(\d+)\b/i
// "@8", "@ 8.5", "rpe 8", "RPE8".
const RPE_RE = /(?:@\s*|rpe\s*)(\d+(?:[.,]\d+)?)/i

/**
 * Lift keywords matched case-insensitively as substrings, mirroring
 * suggestionService.liftKeyFor(). English + common Swedish shorthands.
 * Keys are canonical tokens used for exercise-name matching.
 */
const LIFT_KEYWORDS: Record<string, string[]> = {
  squat: ['squat', 'böj', 'knäböj'],
  bench: ['bench', 'bänk', 'bänkpress'],
  deadlift: ['deadlift', 'marklyft', 'mark', 'dl'],
}

function parseNumber(raw: string): number {
  return Number(raw.replace(',', '.'))
}

export function parseCaption(text: string | null | undefined): ParsedCaption {
  const result: ParsedCaption = { weightKg: null, reps: null, rpe: null, liftKeywords: [] }
  if (!text) return result

  const loadReps = LOAD_REPS_RE.exec(text)
  if (loadReps) {
    const value = parseNumber(loadReps[1])
    const unit = loadReps[2]?.toLowerCase()
    result.weightKg = unit?.startsWith('lb')
      ? Math.round(value * LBS_TO_KG * 10) / 10
      : value
    result.reps = Number(loadReps[3])
  }

  const rpe = RPE_RE.exec(text)
  if (rpe) {
    const value = parseNumber(rpe[1])
    // RPE lives on a 1–10 scale; "@100kg" style captions must not parse as RPE 100.
    if (value >= 1 && value <= 10) result.rpe = value
  }

  const lower = text.toLowerCase()
  for (const [canonical, variants] of Object.entries(LIFT_KEYWORDS)) {
    if (variants.some((v) => keywordHits(v, text, lower))) {
      result.liftKeywords.push(canonical)
    }
  }

  return result
}

/**
 * Short ASCII tokens ('dl', 'mark') need word boundaries so "markera" or
 * "handle" don't hit; longer / non-ASCII tokens match as plain substrings
 * (\b is unreliable next to ö/ä in JS regexes).
 */
function keywordHits(variant: string, original: string, lower: string): boolean {
  // eslint-disable-next-line no-control-regex
  const isAscii = /^[a-z]+$/.test(variant)
  return isAscii && variant.length <= 4
    ? new RegExp(`\\b${variant}\\b`, 'i').test(original)
    : lower.includes(variant)
}

export interface CandidateExercise {
  name: string
  weight: number | null
  load_used: string | null
  reps: string | null
}

export interface CandidateWorkout {
  workoutId: string
  scheduledDate: string // YYYY-MM-DD
  exercises: CandidateExercise[]
}

function dayDiff(a: string, b: string): number {
  // Both are YYYY-MM-DD (UTC) — safe to diff via Date.UTC without TZ drift.
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.abs(Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86_400_000
}

function exerciseMatchesKeyword(exerciseName: string, keywords: string[]): boolean {
  const lower = exerciseName.toLowerCase()
  return keywords.some((canonical) =>
    (LIFT_KEYWORDS[canonical] ?? [canonical]).some((v) => keywordHits(v, exerciseName, lower)),
  )
}

function numericLoad(ex: CandidateExercise): number | null {
  if (ex.weight != null) return ex.weight
  if (ex.load_used) {
    const n = Number(ex.load_used.replace(',', '.').replace(/[^\d.]/g, ''))
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

/**
 * Picks the workout a video most plausibly belongs to, or null.
 *
 * Contract: candidates within ±1 day and exactly one → that one (date alone
 * decides). Otherwise candidates within ±3 days are scored on date proximity
 * and caption↔exercise agreement; only a unique strict-max scorer with a
 * meaningful score (≥3) is suggested. Ambiguity always yields null — the
 * coach picks manually rather than being nudged toward a coin flip.
 */
export function suggestWorkout(
  candidates: CandidateWorkout[],
  parsed: ParsedCaption,
  postedDate: string,
): string | null {
  const within1 = candidates.filter((c) => dayDiff(c.scheduledDate, postedDate) <= 1)
  if (within1.length === 1) return within1[0].workoutId

  const within3 = candidates.filter((c) => dayDiff(c.scheduledDate, postedDate) <= 3)
  if (within3.length === 0) return null

  let best: { id: string; score: number } | null = null
  let tied = false

  for (const c of within3) {
    const diff = dayDiff(c.scheduledDate, postedDate)
    let score = diff === 0 ? 3 : diff <= 1 ? 2 : 1

    const keywordExercises =
      parsed.liftKeywords.length > 0
        ? c.exercises.filter((ex) => exerciseMatchesKeyword(ex.name, parsed.liftKeywords))
        : []
    if (keywordExercises.length > 0) score += 4

    // Load/reps agreement is checked against keyword-matched exercises when we
    // have them, otherwise against the whole day.
    const pool = keywordExercises.length > 0 ? keywordExercises : c.exercises
    if (parsed.weightKg != null) {
      const loadHit = pool.some((ex) => {
        const load = numericLoad(ex)
        return load != null && Math.abs(load - parsed.weightKg!) / load <= 0.075
      })
      if (loadHit) score += 2
    }
    if (parsed.reps != null) {
      const repsHit = pool.some((ex) => ex.reps != null && /^\d+$/.test(ex.reps.trim()) && Number(ex.reps) === parsed.reps)
      if (repsHit) score += 1
    }

    if (!best || score > best.score) {
      best = { id: c.workoutId, score }
      tied = false
    } else if (score === best.score) {
      tied = true
    }
  }

  if (!best || tied || best.score < 3) return null
  return best.id
}
