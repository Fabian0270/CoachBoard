import { sql } from 'kysely'
import { getDb } from '../db.js'
import type { AttentionItem } from 'coachboard-shared'
import { isVbtLift } from 'coachboard-shared/vbt'
import { readSessions, sessionMvt, SLOW_SESSION } from 'coachboard-shared/vbtSession'
import { listAnalyses } from './videoAnalysisService.js'
import { getAthleteMvts } from './athleteMvtService.js'

// ---------------------------------------------------------------------------
// The dashboard's "needs attention" list (I2): what the coach should act on,
// worked out from the program data.
//
//   - a block ending within a week (or already past its end and still active)
//     with no next program for that athlete;
//   - an active program with a training day 7 or more days ago that has
//     nothing logged (D45): a weekly import never trips it, a forgotten one does;
//   - an athlete on the roster with no active program.
//
// `today` comes from the coach's own screen, so "this week" is their week and
// not the server's idea of the time zone.
// ---------------------------------------------------------------------------

const shift = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export async function needsAttention(today: string): Promise<AttentionItem[]> {
  const db = getDb()
  const athletes = await db.selectFrom('athletes').select(['id', 'name']).where('archived', '=', 0).execute()
  const nameOf = new Map(athletes.map((a) => [a.id, a.name]))
  const programs = await db.selectFrom('programs')
    .select(['id', 'athlete_id', 'name', 'start_date', 'end_date', 'status']).execute()
  const active = programs.filter((p) => p.status === 'active' && p.athlete_id && nameOf.has(p.athlete_id))
  const items: AttentionItem[] = []

  // Blocks ending with nothing after them.
  const weekAhead = shift(today, 7)
  for (const p of active) {
    if (!p.end_date || p.end_date > weekAhead) continue
    const hasNext = programs.some((o) =>
      o.id !== p.id && o.athlete_id === p.athlete_id && o.status !== 'archived' &&
      !!o.start_date && !!p.start_date && o.start_date > p.start_date)
    if (hasNext) continue
    items.push({
      kind: 'block-ending', athleteId: p.athlete_id!, athleteName: nameOf.get(p.athlete_id!)!,
      programId: p.id, programName: p.name, date: p.end_date, count: null,
    })
  }

  // Training days a week or more ago with nothing logged.
  const cutoff = shift(today, -7)
  if (active.length > 0) {
    const days = await db.selectFrom('workouts')
      .innerJoin('exercises', 'exercises.workout_id', 'workouts.id')
      .select([
        'workouts.program_id as programId',
        'workouts.scheduled_date as date',
        sql<number>`sum(case when trim(coalesce(exercises.load_used, '')) <> '' or trim(coalesce(exercises.rpe, '')) <> '' then 1 else 0 end)`.as('logged'),
      ])
      .where('workouts.program_id', 'in', active.map((p) => p.id))
      .where('workouts.scheduled_date', '<=', cutoff)
      .groupBy(['workouts.id', 'workouts.program_id', 'workouts.scheduled_date'])
      .execute()
    for (const p of active) {
      const missing = days.filter((d) => d.programId === p.id && Number(d.logged) === 0 && d.date)
      if (missing.length === 0) continue
      items.push({
        kind: 'no-results', athleteId: p.athlete_id!, athleteName: nameOf.get(p.athlete_id!)!,
        programId: p.id, programName: p.name,
        date: missing.map((d) => d.date!).sort().at(-1)!, count: missing.length,
      })
    }
  }

  // Athletes without an active program.
  const withActive = new Set(active.map((p) => p.athlete_id))
  for (const a of athletes) {
    if (withActive.has(a.id)) continue
    items.push({ kind: 'no-program', athleteId: a.id, athleteName: a.name, programId: null, programName: null, date: null, count: null })
  }

  // A bar path session in the last week that read well under the athlete's
  // usual max (BP33, D59) — read exactly as the saved page and Progress tab do.
  for (const a of athletes) {
    const sets = await listAnalyses({ athleteId: a.id, withTrack: false })
    if (sets.length === 0) continue
    const stored = await getAthleteMvts(a.id)
    for (const lift of new Set(sets.map((s) => s.lift).filter(isVbtLift))) {
      for (const s of readSessions(sets, lift, sessionMvt(lift, stored[lift]))) {
        if (s.day < cutoff || s.day > today || s.vsUsual == null || s.vsUsual > -SLOW_SESSION) continue
        items.push({
          kind: 'slow-session', athleteId: a.id, athleteName: a.name, programId: null, programName: null,
          date: s.day, count: null, lift, under: -s.vsUsual,
        })
      }
    }
  }

  const order = { 'block-ending': 0, 'no-results': 1, 'slow-session': 2, 'no-program': 3 } as const
  return items.sort((x, y) =>
    order[x.kind] - order[y.kind] || (x.date ?? '').localeCompare(y.date ?? '') || x.athleteName.localeCompare(y.athleteName))
}
