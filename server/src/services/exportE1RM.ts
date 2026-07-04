// ---------------------------------------------------------------------------
// Helper for the "Modern" export template's per-lift e1RM badge.
//
// The badge value itself is computed by `latestE1RMByLift` in analysisService —
// the SAME report-style estimation from logged sets (no stored-max fallback), so
// the badge and the program report always agree. This module only matches an
// exercise name to its main-lift keyword so the renderer knows which value to show.
// ---------------------------------------------------------------------------

export const MAIN_LIFT_KEYWORDS = ['squat', 'bench', 'deadlift'] as const

/** e1RM reference for a given exercise name, or null when the lift has no reference. */
export function e1rmForExerciseName(name: string, ref: Record<string, number>): number | null {
  const lower = name.toLowerCase()
  const kw = MAIN_LIFT_KEYWORDS.find((k) => lower.includes(k))
  return kw && ref[kw] != null ? ref[kw] : null
}
