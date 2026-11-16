import { Undo2, X } from 'lucide-react'
import { looksMistracked, type RepMetrics } from 'coachboard-shared/videoAnalysis'
import {
  readRep,
  rpeFromLastRepVelocity,
  zoneFor,
  type LrvAnchor,
  type VbtLift,
  type VelocityMetric,
} from 'coachboard-shared/vbt'

// ---------------------------------------------------------------------------
// The per-rep table, the same on the live page and the saved page (BP1, BP2,
// BP4). The saved page had its own: a "Propulsive" column that showed
// whichever speed the set was read from, an RPE off the published chart while
// its headline used the athlete's own, and no Peak, Duration or ⚠.
// ---------------------------------------------------------------------------

interface RepTableProps {
  reps: RepMetrics[]
  lift: VbtLift
  /** The speed the set is read from; its column is marked. */
  metric: VelocityMetric
  /** A scale line was drawn. Without one there is no RPE or quality to show. */
  calibrated: boolean
  /** This athlete's anchors for the lift, this set included — the panel reads the set against the same ones. */
  anchors: LrvAnchor[]
  /** Reps struck off but still listed (the live page, where striking is undone in place). */
  excluded?: Set<number>
  /** Strike a rep off, or count it again. Absent: no strike buttons. */
  onToggle?: (index: number) => void
}

export default function RepTable({ reps, lift, metric, calibrated, anchors, excluded, onToggle }: RepTableProps) {
  const head = (m: VelocityMetric, label: string) => (
    <th className={`py-1 pr-4 font-medium ${metric === m ? 'text-foreground' : ''}`} title={metric === m ? 'The set is read from this one' : undefined}>
      {label}{metric === m && ' •'}
    </th>
  )
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[30rem] text-sm" aria-label="Reps">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-1 pr-4 font-medium">Rep</th>
            {head('mean', 'Mean')}
            {head('propulsive', 'Propulsive')}
            {head('peak', 'Peak')}
            <th className="py-1 pr-4 font-medium">Range</th>
            <th className="py-1 pr-4 font-medium">Duration</th>
            {/* Dropped without a scale rather than shown as dashes: neither an
                RPE table nor a velocity zone means anything in px/s. */}
            {calibrated && (
              <>
                <th className="py-1 pr-4 font-medium">≈ RPE</th>
                <th className="py-1 font-medium">Quality</th>
              </>
            )}
            {onToggle && <th className="py-1 pl-4 font-medium"><span className="sr-only">Strike off</span></th>}
          </tr>
        </thead>
        <tbody>
          {reps.map((r) => {
            const out = excluded?.has(r.index) ?? false
            const suspect = looksMistracked(r)
            // Whatever speed the panel reads the set from, so one rep never carries two RPEs.
            const v = readRep(r, metric)
            const reading = !out && v !== null ? rpeFromLastRepVelocity(lift, v, { anchors }) : null
            const zone = !out && v !== null ? zoneFor(v) : null
            return (
              <tr key={r.index} className={`border-b last:border-0 ${out ? 'text-muted-foreground line-through opacity-60' : ''}`}>
                <td className="py-1 pr-4">
                  {r.index + 1}
                  {suspect && !out && (
                    <span
                      className="ml-1.5 text-warning"
                      title="The peak is far out of line with the mean — the tracker probably jumped here. Strike this rep off or track it again."
                      aria-label="probably mistracked"
                    >
                      ⚠
                    </span>
                  )}
                </td>
                <td className="py-1 pr-4 font-medium">
                  {r.meanVelocity !== null ? `${r.meanVelocity.toFixed(2)} m/s` : `${Math.round(r.meanVelocityPxS)} px/s`}
                </td>
                <td className="py-1 pr-4 font-medium">
                  {r.meanPropulsiveVelocity != null ? `${r.meanPropulsiveVelocity.toFixed(2)} m/s` : '—'}
                  {r.propulsiveFraction != null && (
                    <span className="ml-1 text-xs font-normal text-muted-foreground">{Math.round(r.propulsiveFraction * 100)}%</span>
                  )}
                </td>
                <td className="py-1 pr-4">
                  {r.peakVelocity !== null ? `${r.peakVelocity.toFixed(2)} m/s` : `${Math.round(r.peakVelocityPxS)} px/s`}
                </td>
                <td className="py-1 pr-4">{r.romM !== null ? `${(r.romM * 100).toFixed(0)} cm` : `${Math.round(r.romPx)} px`}</td>
                <td className="py-1 pr-4">{(r.durationMs / 1000).toFixed(2)} s</td>
                {calibrated && (
                  <>
                    <td className="py-1 pr-4">{reading ? reading.rpe : '—'}</td>
                    <td className="py-1 text-muted-foreground">{zone ? zone.label : '—'}</td>
                  </>
                )}
                {onToggle && (
                  <td className="py-1 pl-4 text-right">
                    <button
                      type="button"
                      onClick={() => onToggle(r.index)}
                      title={out ? 'Count this rep again' : 'Not a rep — strike it off'}
                      aria-label={out ? `Count rep ${r.index + 1} again` : `Strike off rep ${r.index + 1}`}
                      className="rounded p-1 text-muted-foreground no-underline hover:bg-muted hover:text-foreground"
                    >
                      {out ? <Undo2 className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                    </button>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
