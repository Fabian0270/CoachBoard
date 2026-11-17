import { repDrift, type RepMetrics, type Sample } from 'coachboard-shared/videoAnalysis'
import { isVbtLift, liftLabel, readRep, type VelocityMetric } from 'coachboard-shared/vbt'

// ---------------------------------------------------------------------------
// The feedback message for the athlete (BP36): a few plain sentences written
// from the set's numbers, then the coach's note. The coach edits it before it
// goes anywhere; this is only a starting point that saves the typing.
// ---------------------------------------------------------------------------

/** Sideways drift below this is ordinary and not worth a sentence, cm. */
const NOTABLE_DRIFT_CM = 3

export function feedbackMessage(set: {
  lift: string | null
  loadKg: number | null
  reps: RepMetrics[]
  metric: VelocityMetric
  /** The RPE the last rep reads as, if the set could be read. */
  rpe: number | null
  track: Sample[] | null
  pixelsPerMetre: number | null
  note: string | null
}): string {
  const sorted = [...set.reps].sort((a, b) => a.startT - b.startT)
  const what = [isVbtLift(set.lift) && set.lift !== 'other' ? liftLabel(set.lift) : null, set.loadKg != null ? `${set.loadKg} kg` : null].filter(Boolean).join(' ')
  const lines: string[] = []
  const count = `${sorted.length} rep${sorted.length === 1 ? '' : 's'}`
  lines.push(what ? `${what} — ${count}.` : `${count}.`)

  const last = sorted.at(-1)
  const lastV = last ? readRep(last, set.metric) : null
  if (lastV != null) lines.push(`Last rep ${lastV.toFixed(2)} m/s${set.rpe != null ? `, about RPE ${set.rpe}` : ''}.`)

  if (set.track && set.pixelsPerMetre) {
    let worst: { rep: number; cm: number } | null = null
    sorted.forEach((r, i) => {
      const d = repDrift(set.track!, r, set.pixelsPerMetre)
      const cm = d?.maxM != null ? Math.abs(d.maxM) * 100 : null
      if (cm != null && (!worst || cm > worst.cm)) worst = { rep: i + 1, cm }
    })
    const w = worst as { rep: number; cm: number } | null
    if (w && w.cm >= NOTABLE_DRIFT_CM) lines.push(`The bar strayed ${Math.round(w.cm)} cm sideways on rep ${w.rep}.`)
  }

  const note = set.note?.trim()
  return note ? `${lines.join(' ')}\n\n${note}` : lines.join(' ')
}
