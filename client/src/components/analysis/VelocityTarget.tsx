import { useMemo } from 'react'
import { Target } from 'lucide-react'
import { describeTarget, judgeSet, parseVelocityTarget, type TargetVerdict, type VelocityTarget } from 'coachboard-shared/velocityTarget'
import type { VelocityMetric } from 'coachboard-shared/vbt'
import type { RepMetrics } from 'coachboard-shared/videoAnalysis'

// ---------------------------------------------------------------------------
// A tracked set against the velocity target of the program row it is linked to
// (BP39, D74, D75), on the live page and the saved page alike: a verdict line
// under the velocity panel, and the same verdict for the rep table's Target
// column, so the two can never disagree.
// ---------------------------------------------------------------------------

export interface SetTarget {
  /** The cell as the coach typed it. */
  text: string
  target: VelocityTarget | null
  verdict: TargetVerdict | null
}

/** Reads the row's target and judges the set's counted reps against it; null when there is no target text. */
export function useSetTarget(text: string | null | undefined, reps: RepMetrics[], metric: VelocityMetric, calibrated: boolean): SetTarget | null {
  return useMemo(() => {
    const t = (text ?? '').trim()
    if (!t) return null
    const target = parseVelocityTarget(t)
    // Speeds in m/s need a scale; without one there is nothing to judge.
    const verdict = target && calibrated ? judgeSet(reps, metric, target) : null
    return { text: t, target, verdict }
  }, [text, reps, metric, calibrated])
}

/** What the rep table's Target column needs. */
export function tableTarget(t: SetTarget | null) {
  if (!t?.target || !t.verdict) return null
  return { verdict: t.verdict, hasSpeed: t.target.min != null, hasLoss: t.target.lossPct != null }
}

export default function VelocityTargetLine({ setTarget, rowName, calibrated }: { setTarget: SetTarget | null; rowName: string | null; calibrated: boolean }) {
  if (!setTarget) return null
  const { text, target, verdict } = setTarget
  const from = rowName ? ` from ${rowName}` : ''
  if (!target) {
    return (
      <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
        <Target className="mt-0.5 h-4 w-4 shrink-0" />
        <span>The velocity target{from} reads “{text}”, which is not a speed or a loss cut-off this page can judge.</span>
      </p>
    )
  }
  const lines: { text: string; tone: string }[] = []
  if (!calibrated || !verdict) {
    lines.push({ text: 'Draw the scale to judge the set against it — the target is in m/s.', tone: 'text-muted-foreground' })
  } else {
    if (verdict.speed && target.min != null) {
      const { inside, total, slowest } = verdict.speed
      const wanted = target.max == null ? `at ${target.min.toFixed(2)} m/s or faster` : `inside ${target.min.toFixed(2)}–${target.max.toFixed(2)} m/s`
      const all = inside === total && total > 0
      lines.push({
        text: total === 0
          ? 'Speed: no rep could be read.'
          : `Speed: ${all ? `all ${total} reps` : `${inside} of ${total} reps`} ${wanted}${!all && slowest != null && slowest < target.min ? ` — slowest ${slowest.toFixed(2)}` : ''}.`,
        tone: all ? 'text-success' : 'text-warning',
      })
    }
    if (target.lossPct != null) {
      const worst = Math.max(0, ...verdict.losses.values())
      const past = verdict.cutoffAt != null ? [...verdict.marks.values()].filter((m) => m.includes('past-cutoff')).length : 0
      lines.push(verdict.cutoffAt == null
        ? { text: `Velocity loss: never reached ${target.lossPct} % (most ${Math.round(worst)} %).`, tone: 'text-success' }
        : {
            text: `Velocity loss: reached ${target.lossPct} % at rep ${verdict.cutoffAt}${past > 0 ? ` — ${past} ${past === 1 ? 'rep' : 'reps'} after the cut-off` : ', the last rep'}.`,
            tone: past > 0 ? 'text-warning' : 'text-success',
          })
    }
  }
  return (
    <div className="space-y-0.5 rounded-md border p-2 text-sm" aria-label="Velocity target">
      <p className="flex items-center gap-1.5 font-medium">
        <Target className="h-4 w-4 text-primary" />
        Target{from}: {describeTarget(target)}
      </p>
      {lines.map((l) => <p key={l.text} className={`pl-[1.375rem] ${l.tone}`}>{l.text}</p>)}
    </div>
  )
}
