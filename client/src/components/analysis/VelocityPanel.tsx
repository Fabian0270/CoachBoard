import { useMemo, useState } from 'react'
import { Gauge, Ruler, TrendingDown } from 'lucide-react'
import { RPE_VALUES } from 'coachboard-shared/rpe'
import type { RepMetrics } from 'coachboard-shared/videoAnalysis'
import {
  VBT_LIFTS,
  LRV_TOLERANCE_MS,
  MVT_RANGE,
  bestRepVelocity,
  buildLoadVelocityProfile,
  defaultMvt,
  e1RMFromVelocity,
  effectiveRpe,
  effortLabel,
  recordedMaxFor,
  resolveLvSlope,
  isVbtLift,
  lastRepVelocity,
  liftLabel,
  lrvChart,
  rpeFromLastRepVelocity,
  velocityLoss,
  zoneFor,
  type LrvAnchor,
  type LvPoint,
  type LvWarning,
  type SlopeSource,
  type VbtLift,
} from 'coachboard-shared/vbt'
import { num } from '../../lib/num'
import { Button } from '../ui/button'
import LoadVelocityChart from './LoadVelocityChart'

// ---------------------------------------------------------------------------
// Velocity-based training readouts for one tracked set.
//
// The tracker measures; this interprets. Everything here is derived — nothing
// is measured twice — so the panel costs a render, not a re-track.
//
// House rule for the whole file: no m/s number is shown without a scale line.
// The page already refuses to report an uncalibrated velocity in metres, and a
// px/s figure compared against a published m/s table would be nonsense with no
// visible symptom.
// ---------------------------------------------------------------------------

const LIFT_STORAGE_KEY = 'coachboard-vbt-lift'

/**
 * The lift last worked on, for the page to seed its state with.
 *
 * A coach works through an inbox of clips one lift at a time, so re-picking
 * "back squat" on every video is pure friction. Same idea as `useTrackerColor`
 * for the overlay colour, but the value lives in the page rather than here — it
 * has to travel up into the save payload either way.
 */
export function rememberedLift(): VbtLift {
  try {
    const stored = localStorage.getItem(LIFT_STORAGE_KEY)
    return isVbtLift(stored) ? stored : 'back-squat'
  } catch {
    return 'back-squat'
  }
}

function rememberLift(lift: VbtLift): void {
  try {
    localStorage.setItem(LIFT_STORAGE_KEY, lift)
  } catch {
    // A locked-down browser profile is not a reason to break the panel.
  }
}

const fmtV = (v: number) => `${v.toFixed(2)} m/s`
const fmtKg = (kg: number) => `${Math.round(kg * 2) / 2} kg`

/**
 * Where the slope came from, in the coach's language.
 *
 * Said out loud on every estimate because it is the whole accuracy question: the
 * same set reads 245 kg on a population slope and 250 on this athlete's own.
 */
const SLOPE_SOURCE: Record<SlopeSource, string> = {
  profile: 'on his own load–velocity profile',
  calibrated: 'calibrated to his recorded max',
  published: 'on the published slope for this lift',
  estimated: 'on a generic slope — records a max or a second load to make it his',
}

const WARNING_TEXT: Record<LvWarning, string> = {
  'too-few-points': 'Fewer than three sets — the line is not yet a profile.',
  'narrow-load-range':
    'All the loads sit close together. Spread sets across roughly 60–90% of the max for a profile worth extrapolating.',
  'poor-fit': 'The sets scatter around the line, so the projected max is a rough guide at best.',
  'positive-slope': 'The bar moved faster as the load went up — that is not a load-velocity profile.',
}

export interface SetContextState {
  lift: VbtLift
  loadText: string
  calledRpe: number | null
}

interface Props {
  reps: RepMetrics[]
  calibrated: boolean
  athleteName: string | null
  /** Every anchor for this lift, this set included — resolved by the page so its
   *  rep table and this panel never disagree about the same rep. */
  anchors: LrvAnchor[]
  /** The athlete's previously saved (load, velocity) pairs for this lift, newest first. */
  savedPoints: LvPoint[]
  /** Recorded maxes, for calibrating the estimate against a real one. */
  maxes: { lift_name: string; weight: number }[]
  value: SetContextState
  onChange: (next: SetContextState) => void
  /** Puts the page into calibrate mode. The scale is the one thing standing
   *  between a coach and every reading here, so the fix belongs where they
   *  notice the problem, not only in the toolbar above the video. */
  onSetScale?: () => void
}

export default function VelocityPanel({
  reps,
  calibrated,
  athleteName,
  anchors: allAnchors,
  savedPoints,
  maxes,
  value,
  onChange,
  onSetScale,
}: Props) {
  const [mvtText, setMvtText] = useState('')
  const [targetRpe, setTargetRpe] = useState(8)

  const lift = value.lift
  const loadKg = value.loadText.trim() ? num(value.loadText) : null
  const validLoad = loadKg != null && Number.isFinite(loadKg) && loadKg > 0 ? loadKg : null

  const lastV = calibrated ? lastRepVelocity(reps) : null
  const bestV = calibrated ? bestRepVelocity(reps) : null

  const chart = useMemo(() => lrvChart(lift, allAnchors), [lift, allAnchors])
  const reading = useMemo(
    () =>
      lastV == null
        ? null
        : rpeFromLastRepVelocity(lift, lastV, { anchors: allAnchors, calledRpe: value.calledRpe }),
    [lift, lastV, allAnchors, value.calledRpe],
  )
  const loss = useMemo(() => velocityLoss(reps), [reps])

  /** What to put on screen — see effectiveRpe for why it is not always the bar's own number. */
  const shownRpe = reading ? effectiveRpe(reading, value.calledRpe) : 0

  const knownMax = useMemo(() => recordedMaxFor(lift, maxes), [lift, maxes])

  const suggestedMvt = useMemo(() => defaultMvt(lift, allAnchors), [lift, allAnchors])
  const mvt = mvtText.trim() && Number.isFinite(num(mvtText)) ? num(mvtText) : suggestedMvt

  const lvPoints = useMemo(() => {
    const points = [...savedPoints]
    if (validLoad != null && bestV != null) {
      points.push({ load: validLoad, velocity: bestV, label: 'this set' })
    }
    return points
  }, [savedPoints, validLoad, bestV])

  const profile = useMemo(
    () => (mvt != null ? buildLoadVelocityProfile(lvPoints, mvt) : null),
    [lvPoints, mvt],
  )

  // Calibration deliberately uses the most recent SAVED set, never the current
  // one: calibrating off the set you are estimating just hands the recorded max
  // straight back.
  const calibration = useMemo(
    () =>
      knownMax != null && mvt != null && savedPoints.length > 0
        ? {
            knownMax,
            loadKg: savedPoints[0].load,
            velocity: savedPoints[0].velocity,
            mvt,
          }
        : null,
    [knownMax, mvt, savedPoints],
  )

  const slope = useMemo(
    () => resolveLvSlope(lift, { profile, calibration }),
    [lift, profile, calibration],
  )

  const estimate = useMemo(
    () =>
      lastV != null && validLoad != null && mvt != null
        ? e1RMFromVelocity({ loadKg: validLoad, velocity: lastV, mvt, slope })
        : null,
    [lastV, validLoad, mvt, slope],
  )

  /** Where this set sat against a max the coach has actually recorded. */
  const pctOfRecorded = knownMax != null && validLoad != null ? validLoad / knownMax : null

  const targetVelocity = chart?.velocityAt(targetRpe) ?? null
  const targetLoad = profile && targetVelocity != null ? profile.loadForVelocity(targetVelocity) : null

  const setLift = (next: VbtLift) => {
    rememberLift(next)
    onChange({ ...value, lift: next })
    // The MVT belongs to a lift, so a leftover override from the previous one
    // would be silently wrong.
    setMvtText('')
  }

  return (
    <div className="space-y-5 rounded-md border p-4">
      <div className="flex items-center gap-2">
        <Gauge className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Velocity-based training</h2>
      </div>

      {/* 1. What the set was — none of the rest means anything without this. */}
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Lift</span>
          <select
            value={lift}
            onChange={(e) => setLift(e.target.value as VbtLift)}
            className="rounded-md border bg-background px-2 py-1 text-sm"
          >
            {VBT_LIFTS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Load</span>
          <input
            value={value.loadText}
            onChange={(e) => onChange({ ...value, loadText: e.target.value })}
            inputMode="decimal"
            placeholder="kg"
            className="w-24 rounded-md border bg-background px-2 py-1 text-sm"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">RPE called</span>
          <select
            value={value.calledRpe ?? ''}
            onChange={(e) =>
              onChange({ ...value, calledRpe: e.target.value === '' ? null : Number(e.target.value) })
            }
            className="rounded-md border bg-background px-2 py-1 text-sm"
          >
            <option value="">—</option>
            {RPE_VALUES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>

        <p className="ml-auto max-w-xs text-xs text-muted-foreground">
          Saved with the analysis, so the profile below builds up over time.
        </p>
      </div>

      {/* Velocity loss is a ratio, so it survives having no scale — it is the one
          reading here that does, and it was on this page before any of the rest
          of the panel existed. Shown above the calibration gate for that reason. */}
      {loss && (
        <div className="flex flex-wrap items-baseline gap-2 text-sm">
          <TrendingDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>
            Velocity loss <span className="font-medium">{Math.round(loss.lossPct)}%</span> from the
            fastest rep to the last.
          </span>
          {!loss.reliable && (
            <span className="text-xs text-muted-foreground">
              Over {loss.reps} {loss.reps === 1 ? 'rep' : 'reps'} that number says little — below four
              reps there is barely any drop-off to measure, and on a flat day the first rep is already
              slow. Last-rep velocity is the signal to read instead.
            </span>
          )}
        </div>
      )}

      {!calibrated ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-primary/40 bg-primary/5 p-3">
          <Ruler className="h-4 w-4 shrink-0 text-primary" />
          <p className="max-w-xl text-sm">
            No scale set, so the tracker can only report pixels per second. Everything else here —
            the RPE reading, the profile, the estimated max — is measured in m/s against published
            tables, and a pixel figure compared against those would be quietly wrong.
            <span className="block text-muted-foreground">
              Drag a line across a plate of known diameter and all of it appears.
            </span>
          </p>
          {onSetScale && (
            <Button size="sm" className="ml-auto" onClick={onSetScale}>
              <Ruler className="h-4 w-4" /> Set scale
            </Button>
          )}
        </div>
      ) : (
        <>
          {/* 2. The headline: what the last rep says the set was worth. */}
          {lastV != null && reading && chart ? (
            <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
              <p className="text-sm">
                Last rep <span className="font-medium">{fmtV(lastV)}</span> — about{' '}
                <span className="font-medium">RPE {shownRpe}</span>{' '}
                <span className="text-muted-foreground">({effortLabel(shownRpe)})</span>
                {reading.outsideChart && (
                  <span className="text-muted-foreground">
                    {' '}
                    · off the end of the chart, so treat it as a direction, not a number
                  </span>
                )}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{directive(shownRpe)}</p>
              {reading.agreement && value.calledRpe != null && (
                <p className="mt-2 text-sm">
                  {reading.agreement === 'match' ? (
                    <>
                      That matches the RPE {value.calledRpe} called, within ±{LRV_TOLERANCE_MS} m/s.
                    </>
                  ) : (
                    <>
                      Called RPE {value.calledRpe}, bar says {reading.rpe} — the set was{' '}
                      <span className="font-medium">
                        {reading.agreement === 'harder' ? 'harder' : 'easier'}
                      </span>{' '}
                      than it felt.
                    </>
                  )}
                </p>
              )}

              {/* Straight from velocity to %1RM, not via reps and the RPE chart.
                  RPE-to-%1RM is individual — a strong lifter has more in reserve
                  than the chart assumes — where velocity at a given relative load
                  is the thing VBT finds consistent. */}
              {estimate ? (
                <p className="mt-2 border-t pt-2 text-sm">
                  <span className="font-medium">
                    Estimated 1RM {fmtKg(estimate.e1rm)}
                  </span>{' '}
                  <span className="text-muted-foreground">
                    — this set at {Math.round(estimate.pctOf1RM * 100)}%, from {fmtV(lastV)} against a{' '}
                    {estimate.mvt.toFixed(2)} m/s max velocity · {SLOPE_SOURCE[slope.source]}
                  </span>
                  {pctOfRecorded != null && knownMax != null && (
                    <span className="block text-muted-foreground">
                      His recorded max is {fmtKg(knownMax)}, so this set was{' '}
                      {Math.round(pctOfRecorded * 100)}% of it
                      {agreementNote(estimate.e1rm, knownMax)}.
                    </span>
                  )}
                </p>
              ) : (
                validLoad != null && (
                  <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">
                    No 1RM estimate from this set — the bar was at or below the{' '}
                    {mvt?.toFixed(2) ?? '—'} m/s max velocity, so there is nothing left to
                    extrapolate.
                  </p>
                )
              )}
            </div>
          ) : lastV == null ? (
            <p className="text-sm text-muted-foreground">No completed rep to read a velocity from.</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              No velocity reference published for {liftLabel(lift)}. Track a set, enter the RPE it was
              called at, and save it — three of those build a chart for this athlete.
            </p>
          )}

          {/* 3. The chart itself, and where its numbers came from. */}
          {chart && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium">Last-rep velocity by RPE — {liftLabel(lift)}</h3>
                <p className="text-xs text-muted-foreground">
                  {chart.source === 'personal'
                    ? `Fitted to ${athleteName ?? 'this athlete'}'s ${allAnchors.length} called sets`
                    : 'Published reference values'}{' '}
                  · {Math.abs(chart.fit.slope).toFixed(3)} m/s per RPE point
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[28rem] text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      {chart.rows.map((r) => (
                        <th key={r.rpe} className="py-1 pr-3 font-medium">
                          {r.rpe}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      {chart.rows.map((r) => (
                        <td
                          key={r.rpe}
                          className={`py-1 pr-3 ${
                            reading && Math.abs(shownRpe - r.rpe) < 0.01 ? 'font-semibold' : ''
                          }`}
                        >
                          {r.velocity > 0 ? r.velocity.toFixed(2) : '—'}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 5. The profile: several loads, one line, one estimated max. */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium">Load–velocity profile</h3>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Ruler className="h-3.5 w-3.5" />
                1RM velocity
                <input
                  value={mvtText}
                  onChange={(e) => setMvtText(e.target.value)}
                  placeholder={suggestedMvt ? suggestedMvt.toFixed(2) : '—'}
                  inputMode="decimal"
                  className="w-16 rounded-md border bg-background px-1.5 py-0.5 text-right text-xs"
                />
                m/s
                {MVT_RANGE[lift] && (
                  <span>
                    (typical {MVT_RANGE[lift]!.elite.toFixed(2)}–{MVT_RANGE[lift]!.novice.toFixed(2)})
                  </span>
                )}
              </label>
            </div>

            {profile ? (
              <>
                <LoadVelocityChart profile={profile} />
                <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  <Stat
                    label={`Estimated 1RM at ${mvt!.toFixed(2)} m/s`}
                    value={profile.oneRm ? fmtKg(profile.oneRm) : '—'}
                  />
                  <Stat label="Sets in the profile" value={`${profile.points.length}`} />
                  <Stat label="Slope" value={`${(profile.fit.slope * 1000).toFixed(1)} m/s per 100 kg`} />
                  <Stat label="Fit (R²)" value={profile.fit.r2.toFixed(3)} />
                  {validLoad != null && profile.pctOf1RM(validLoad) != null && (
                    <Stat
                      label="This set"
                      value={`${Math.round(profile.pctOf1RM(validLoad)! * 100)}% of the estimate`}
                    />
                  )}
                </div>
                {profile.warnings.map((w) => (
                  <p key={w} className="text-xs text-muted-foreground">
                    {WARNING_TEXT[w]}
                  </p>
                ))}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {/* Counts what is actually there. Telling a coach who has just
                    typed 205 kg to "enter the load" reads as the panel not
                    having noticed. */}
                {lvPoints.length === 0 ? (
                  <>
                    Enter the load for this set. It plus two more {liftLabel(lift).toLowerCase()} sets
                    at different loads — spread across roughly 60–90% of the max — build a profile and
                    an estimated 1RM.
                  </>
                ) : (
                  <>
                    {lvPoints.length} {lvPoints.length === 1 ? 'set' : 'sets'} so far
                    {validLoad != null && bestV != null && ` (${fmtKg(validLoad)} at ${fmtV(bestV)})`}.
                    Save this one, then track {3 - lvPoints.length} more at different loads and the
                    profile appears. Spread them across roughly 60–90% of the max — sets bunched
                    together fit a line neatly and project a max that is mostly noise.
                  </>
                )}
              </p>
            )}
          </div>

          {/* 6. The whole point: turn all of it back into a number to lift. */}
          {chart && targetVelocity != null && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm">
              <span className="text-muted-foreground">Next set at</span>
              <select
                value={targetRpe}
                onChange={(e) => setTargetRpe(Number(e.target.value))}
                className="rounded-md border bg-background px-2 py-1 text-sm"
              >
                {RPE_VALUES.map((r) => (
                  <option key={r} value={r}>
                    RPE {r}
                  </option>
                ))}
              </select>
              <span>
                — stop the set when the bar drops to{' '}
                <span className="font-medium">{fmtV(targetVelocity)}</span>
                {targetLoad != null && profile?.oneRm && (
                  <>
                    , about <span className="font-medium">{fmtKg(targetLoad)}</span> on today&rsquo;s
                    profile
                  </>
                )}
                .
              </span>
            </div>
          )}

          {/* 7. Training quality — separately sourced, and labelled as such. */}
          {lastV != null && zoneFor(lastV) && (
            <p className="text-xs text-muted-foreground">
              Training quality: <span className="font-medium text-foreground">{zoneFor(lastV)!.label}</span>{' '}
              — {zoneFor(lastV)!.summary.toLowerCase()}. General velocity-zone reference, not part of the
              RPE tables above.
            </p>
          )}
        </>
      )}
    </div>
  )
}

/**
 * How far apart the two independent 1RM estimates are.
 *
 * They come down different paths — one through the velocity chart and the RPE
 * table, one through a regression across loads — so a wide gap is worth saying
 * out loud rather than presenting two confident numbers side by side.
 */
function agreementNote(estimated: number, recorded: number): string {
  const gap = (estimated - recorded) / recorded
  if (Math.abs(gap) < 0.03) return ' — the estimate agrees with it'
  return estimated > recorded
    ? ` — the bar says he is about ${Math.round(gap * 100)}% ahead of that`
    : ` — the bar reads ${Math.round(-gap * 100)}% under it, so either he is down today or the max is stale`
}

/** What to do about it, in one sentence. */
function directive(rpe: number): string {
  if (rpe >= 9.5) return 'That was a maximum — there was nothing left in the tank.'
  if (rpe >= 8.5) return 'A tough set, roughly one rep in reserve. Hold this load.'
  if (rpe >= 7.5) return 'Two to three reps in reserve. Room to add load if this was meant as a top set.'
  if (rpe >= 6.5) return 'A moderate set — comfortably submaximal. Add load next set.'
  return 'Light for this lift. Fine for speed work; add load if the intent was strength.'
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b py-1 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}
