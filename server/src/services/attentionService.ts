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
//   - an athlete on the roster with no active program;
//   - a bar path session that read well under the athlete's usual max.
//
// Not here on purpose (D114): training days with nothing logged. Programs go
// out as Excel and typically come back when the block is done, often after a
// month, so a week-old unlogged day is the normal state, not a warning.
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
  // The tour's sample athlete never needs the coach's attention (T7).
  const athletes = await db.selectFrom('athletes').select(['id', 'name']).where('archived', '=', 0).where('is_sample', '=', 0).execute()
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
      programId: p.id, programName: p.name, date: p.end_date,
    })
  }

  // Athletes without an active program.
  const withActive = new Set(active.map((p) => p.athlete_id))
  for (const a of athletes) {
    if (withActive.has(a.id)) continue
    items.push({ kind: 'no-program', athleteId: a.id, athleteName: a.name, programId: null, programName: null, date: null })
  }

  // A bar path session in the last week that read well under the athlete's
  // usual max (BP33, D59) — read exactly as the saved page and Progress tab do.
  const cutoff = shift(today, -7)
  for (const a of athletes) {
    const sets = await listAnalyses({ athleteId: a.id, withTrack: false })
    if (sets.length === 0) continue
    const stored = await getAthleteMvts(a.id)
    for (const lift of new Set(sets.map((s) => s.lift).filter(isVbtLift))) {
      for (const s of readSessions(sets, lift, sessionMvt(lift, stored[lift]))) {
        if (s.day < cutoff || s.day > today || s.vsUsual == null || s.vsUsual > -SLOW_SESSION) continue
        items.push({
          kind: 'slow-session', athleteId: a.id, athleteName: a.name, programId: null, programName: null,
          date: s.day, lift, under: -s.vsUsual,
        })
      }
    }
  }

  const order = { 'block-ending': 0, 'slow-session': 1, 'no-program': 2 } as const
  return items.sort((x, y) =>
    order[x.kind] - order[y.kind] || (x.date ?? '').localeCompare(y.date ?? '') || x.athleteName.localeCompare(y.athleteName))
}
