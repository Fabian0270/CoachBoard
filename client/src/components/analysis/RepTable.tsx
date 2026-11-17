import { useMemo } from 'react'
import { Undo2, X } from 'lucide-react'
import { looksMistracked, repDrift, repTempos, type RepDrift, type RepMetrics, type Sample } from 'coachboard-shared/videoAnalysis'
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
  /** The tracked path, for each rep's sideways drift (BP8). */
  track?: Sample[] | null
  pixelsPerMetre?: number | null
  /** Strike a rep off, or count it again. Absent: no strike buttons. */
  onToggle?: (index: number) => void
  /** Jump the video to a rep (BP9). Absent: the rep number is plain text. */
  onJump?: (index: number) => void
}

/** "4 cm, ends 2 cm →": the furthest it strayed, and where the top ended up against the bottom. */
export function fmtDrift(d: RepDrift): string {
  const unit = d.maxM != null ? 'cm' : 'px'
  const val = (px: number, m: number | null) => (m != null ? Math.round(Math.abs(m) * 100) : Math.round(Math.abs(px)))
  const net = val(d.netPx, d.netM)
  const ends = net === 0 ? 'centred' : `${net} ${unit} ${d.netPx > 0 ? '→' : '←'}`
  return `${val(d.maxPx, d.maxM)} ${unit}, ends ${ends}`
}

export default function RepTable({ reps, lift, metric, calibrated, anchors, track, pixelsPerMetre = null, excluded, onToggle, onJump }: RepTableProps) {
  // The way down and the pause at the bottom (BP12), from the path like the drift.
  const tempos = useMemo(() => (track ? repTempos(track, reps) : null), [track, reps])
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`
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
            {track && (
              <th className="py-1 pr-4 font-medium" title="Furthest the bar strayed sideways from the line straight up from the bottom, and where the top ended up (arrows: left or right in the picture)">
                Sideways
              </th>
            )}
            {track && (
              <>
                <th className="py-1 pr-4 font-medium" title="How long the bar took on the way down, from the top to the bottom">Down</th>
                <th className="py-1 pr-4 font-medium" title="How long the bar sat at the bottom before it moved up again; 0.0 s is touch-and-go">Pause</th>
              </>
            )}
            <th className="py-1 pr-4 font-medium" title="How long the bar took on the way up">Duration</th>
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
          {reps.map((r, i) => {
            const out = excluded?.has(r.index) ?? false
            const tempo = tempos?.[i] ?? null
            const suspect = looksMistracked(r)
            // Whatever speed the panel reads the set from, so one rep never carries two RPEs.
            const v = readRep(r, metric)
            const reading = !out && v !== null ? rpeFromLastRepVelocity(lift, v, { anchors }) : null
            const zone = !out && v !== null ? zoneFor(v) : null
            const drift = track ? repDrift(track, r, pixelsPerMetre) : null
            return (
              <tr key={r.index} className={`border-b last:border-0 ${out ? 'text-muted-foreground line-through opacity-60' : ''}`}>
                <td className="py-1 pr-4">
                  {onJump ? (
                    <button
                      type="button"
                      onClick={() => onJump(r.index)}
                      title={r.index < 9 ? `Jump to this rep (${r.index + 1})` : 'Jump to this rep'}
                      aria-label={`Jump to rep ${r.index + 1}`}
                      className="rounded px-1 font-medium text-primary underline-offset-2 hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                    >
                      {r.index + 1}
                    </button>
                  ) : r.index + 1}
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
                {track && <td className="num whitespace-nowrap py-1 pr-4">{drift ? fmtDrift(drift) : '—'}</td>}
                {track && (
                  <>
                    <td className="py-1 pr-4">{tempo ? secs(tempo.descentMs) : '—'}</td>
                    <td className="py-1 pr-4">{tempo ? secs(tempo.pauseMs) : '—'}</td>
                  </>
                )}
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
