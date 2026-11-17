import type { ParsedCaption } from 'coachboard-shared/discord'
import type { VbtLift } from 'coachboard-shared/vbt'

// ---------------------------------------------------------------------------
// What a Discord caption says about the set (BP14): "180 kg for 2 @8, bänk".
//
// The server already parses every caption; the bar path page never read it,
// so lift, load, reps and RPE all started empty on a clip that carried them.
// Only what the caption says for certain is filled in, and the page marks it
// "from caption" until the coach changes it.
// ---------------------------------------------------------------------------

export type CaptionField = 'lift' | 'load' | 'reps' | 'rpe'

/** The caption's lift words, as the bar path page's lifts. A deadlift is read as conventional; sumo is picked by hand. */
const LIFTS: Record<string, VbtLift> = {
  squat: 'back-squat',
  bench: 'bench-press',
  deadlift: 'deadlift-conventional',
}

export function captionFill(cap: ParsedCaption | null | undefined): Partial<{ lift: VbtLift; load: number; reps: number; rpe: number }> {
  if (!cap) return {}
  const out: Partial<{ lift: VbtLift; load: number; reps: number; rpe: number }> = {}
  // One lift named, or none: "squat then bench" says nothing about this clip.
  const lifts = cap.liftKeywords.map((k) => LIFTS[k]).filter(Boolean)
  if (lifts.length === 1) out.lift = lifts[0]
  if (cap.weightKg != null && cap.weightKg > 0 && cap.weightKg <= 1000) out.load = cap.weightKg
  if (cap.reps != null && cap.reps > 0 && cap.reps <= 30) out.reps = cap.reps
  // The page takes half steps from 5 to 10, as the saved set does.
  if (cap.rpe != null && cap.rpe >= 5 && cap.rpe <= 10 && Number.isInteger(cap.rpe * 2)) out.rpe = cap.rpe
  return out
}
