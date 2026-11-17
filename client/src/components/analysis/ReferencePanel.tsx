import type { RepMetrics, Sample } from 'coachboard-shared/videoAnalysis'
import { liftLabel, isVbtLift, type VelocityMetric } from 'coachboard-shared/vbt'
import { compareToReference, type ReferenceShape } from './referenceRep'

// ---------------------------------------------------------------------------
// How this set differs from the athlete's reference rep (BP28, D57): range and
// sideways drift always, speed only at exactly the same load. The ghost path
// on the video shows the same thing as a shape.
// ---------------------------------------------------------------------------

const cm = (v: number | null) => (v == null ? '—' : `${Math.round(v)} cm`)
const diff = (v: number | null, ref: number | null, unit: string, digits = 0) => {
  if (v == null || ref == null) return null
  const d = v - ref
  const s = `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(digits)} ${unit}`
  return Math.abs(d) < (digits ? 0.005 : 0.5) ? null : s
}

export default function ReferencePanel({ shape, reps, track, pixelsPerMetre, loadKg, metric, athleteName }: {
  shape: ReferenceShape
  reps: RepMetrics[]
  track: Sample[]
  pixelsPerMetre: number | null
  loadKg: number | null
  metric: VelocityMetric
  athleteName: string | null
}) {
  const ref = shape.analysis
  if (!pixelsPerMetre) {
    return (
      <p className="text-sm text-muted-foreground">
        {athleteName ?? 'This athlete'} has a reference rep for this lift. Set the scale on this clip to draw it over the video and compare.
      </p>
    )
  }
  const { reference, reps: rows, sameLoad } = compareToReference(shape, { reps, track, pixelsPerMetre, loadKg }, metric)
  const lift = isVbtLift(ref.lift) ? liftLabel(ref.lift).toLowerCase() : 'lift'
  return (
    <div className="space-y-2 rounded-md border p-4">
      <h2 className="text-sm font-medium">Against the reference rep</h2>
      <p className="text-xs text-muted-foreground">
        {athleteName ? `${athleteName}'s` : 'The'} reference {lift}: rep {shape.rep.index + 1} of the
        {ref.loadKg != null ? ` ${ref.loadKg} kg` : ''} set on {ref.createdAt.slice(0, 10)}. Drawn dashed over
        the video from the top of each rep.
        {!sameLoad && ` Speed is only compared at the same load${ref.loadKg != null ? ` (${ref.loadKg} kg)` : ''}.`}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[22rem] text-sm" aria-label="Against the reference rep">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-1 pr-4 font-medium" />
              <th className="py-1 pr-4 font-medium">Range</th>
              <th className="py-1 pr-4 font-medium">Sideways</th>
              {sameLoad && <th className="py-1 font-medium">Speed</th>}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b text-muted-foreground">
              <td className="py-1 pr-4">{reference.label}</td>
              <td className="py-1 pr-4">{cm(reference.rangeCm)}</td>
              <td className="py-1 pr-4">{cm(reference.driftCm)}</td>
              {sameLoad && <td className="py-1">{reference.speed != null ? `${reference.speed.toFixed(2)} m/s` : '—'}</td>}
            </tr>
            {rows.map((r) => {
              const dr = diff(r.rangeCm, reference.rangeCm, 'cm')
              const dd = diff(r.driftCm, reference.driftCm, 'cm')
              const ds = diff(r.speed, reference.speed, 'm/s', 2)
              return (
                <tr key={r.label} className="border-b last:border-0">
                  <td className="py-1 pr-4">{r.label}</td>
                  <td className="py-1 pr-4">{cm(r.rangeCm)}{dr && <span className="ml-1 text-xs text-muted-foreground">{dr}</span>}</td>
                  <td className="py-1 pr-4">{cm(r.driftCm)}{dd && <span className="ml-1 text-xs text-muted-foreground">{dd}</span>}</td>
                  {sameLoad && <td className="py-1">{r.speed != null ? `${r.speed.toFixed(2)} m/s` : '—'}{ds && <span className="ml-1 text-xs text-muted-foreground">{ds}</span>}</td>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
