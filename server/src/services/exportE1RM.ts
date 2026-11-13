import { mainLiftKey } from 'coachboard-shared/vbt'

// ---------------------------------------------------------------------------
// Helper for the "Modern" export template's per-lift e1RM badge.
//
// The badge value itself is computed by `latestE1RMByLift` in analysisService —
// the SAME report-style estimation from logged sets (no stored-max fallback), so
// the badge and the program report always agree. This module only matches an
// exercise name to its competition lift so the renderer knows which value to
// show — through the shared matcher, so a Romanian deadlift does not get the
// deadlift's badge.
// ---------------------------------------------------------------------------

/** e1RM reference for a given exercise name, or null when the lift has no reference. */
export function e1rmForExerciseName(name: string, ref: Record<string, number>): number | null {
  const key = mainLiftKey(name)
  return key && ref[key] != null ? ref[key] : null
}
