// ---------------------------------------------------------------------------
// A session's estimated max (BP33, D59).
//
// An athlete's saved sets of one lift on one day — warm-ups to top set — give
// that day's load-velocity line, and the line gives "today's estimated max".
// Against the athlete's usual (the median of their other days that could be
// read), it says how today went: "about 4 % under".
//
// A day is only read when its line can be trusted: at least three sets, a
// negative slope, a good fit and loads spread across a real range. A thin day
// gets no number rather than a confident wrong one. Pure, so the client and
// the dashboard's server read sessions the same way.
// ---------------------------------------------------------------------------

import { buildLoadVelocityProfile, defaultVelocityMetric, isVbtLift, readRep, resolveMvt, type LvPoint, type VbtLift } from './vbt.js'
import { looksMistracked, type RepMetrics } from './videoAnalysis.js'

export interface SessionSet {
  id: string
  lift: string | null
  loadKg: number | null
  /** When the set was lifted, ISO. */
  liftedAt: string
  metrics: RepMetrics[]
}

/** A local calendar day, YYYY-MM-DD — sessions are days as the coach lives them, not UTC days. */
export function localDay(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export interface SessionReading {
  day: string
  lift: VbtLift
  /** Sets that day with a load and a usable rep. */
  sets: number
  /** Today's estimated max, kg; null when the day's line cannot be trusted. */
  todayMax: number | null
  /** The median of the athlete's other readable days; null without one. */
  usualMax: number | null
  /** today / usual − 1; negative is under. */
  vsUsual: number | null
  /** Why there is no number for today. */
  unreadable?: 'too-few-sets' | 'unclear-line'
}

const MIN_SETS = 3

/** How far under the usual a session must read to be flagged on the dashboard (D59). */
export const SLOW_SESSION = 0.07

/**
 * The 1RM velocity sessions are read against: the athlete's stored value for
 * the lift, else the published default. One rule for every page and the
 * dashboard, so the same day never reads two ways.
 */
export function sessionMvt(lift: VbtLift, stored: number | null | undefined): number | null {
  return resolveMvt(lift, { stored: stored ?? null })
}

/** One point per set: its load and its fastest counted rep in the lift's standard measure. */
function point(set: SessionSet, lift: VbtLift): LvPoint | null {
  if (set.loadKg == null || set.loadKg <= 0) return null
  const metric = defaultVelocityMetric(lift)
  const speeds = set.metrics.filter((r) => !looksMistracked(r)).map((r) => readRep(r, metric)).filter((v): v is number => v != null)
  return speeds.length ? { load: set.loadKg, velocity: Math.max(...speeds) } : null
}

/** The max one day's sets read, or why not. */
function dayMax(points: LvPoint[], mvt: number): { max: number | null; unreadable?: SessionReading['unreadable'] } {
  if (points.length < MIN_SETS) return { max: null, unreadable: 'too-few-sets' }
  const profile = buildLoadVelocityProfile(points, mvt)
  if (!profile || profile.oneRm == null || profile.warnings.length > 0) return { max: null, unreadable: 'unclear-line' }
  return { max: profile.oneRm }
}

/** Every day of one lift for an athlete, read; newest first. */
export function readSessions(sets: SessionSet[], lift: VbtLift, mvt: number | null): SessionReading[] {
  if (!isVbtLift(lift) || lift === 'other' || mvt == null) return []
  const byDay = new Map<string, LvPoint[]>()
  for (const s of sets) {
    if (s.lift !== lift) continue
    const p = point(s, lift)
    if (!p) continue
    const day = localDay(s.liftedAt)
    byDay.set(day, [...(byDay.get(day) ?? []), p])
  }
  const read = [...byDay.entries()].map(([day, points]) => ({ day, points, ...dayMax(points, mvt) }))
  return read
    .map((r) => {
      const others = read.filter((o) => o.day !== r.day && o.max != null).map((o) => o.max!).sort((a, b) => a - b)
      const usualMax = others.length ? others[Math.floor((others.length - 1) / 2)] : null
      return {
        day: r.day,
        lift,
        sets: r.points.length,
        todayMax: r.max,
        usualMax,
        vsUsual: r.max != null && usualMax != null ? r.max / usualMax - 1 : null,
        ...(r.unreadable ? { unreadable: r.unreadable } : {}),
      }
    })
    .sort((a, b) => b.day.localeCompare(a.day))
}
