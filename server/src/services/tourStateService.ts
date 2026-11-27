import { getDb } from '../db.js'

// ---------------------------------------------------------------------------
// Where the first-start tour and the setup checklist stand (T8).
//
// In the database, not the browser's local storage: local storage is kept per
// port and is not in the backup, so a restore — or the app falling back to
// another port — would greet a coach of two years with "Welcome to CoachBoard".
// ---------------------------------------------------------------------------

export interface TourState {
  /** The first-launch welcome (D19) or the one-time offer to existing coaches (D21) was answered. */
  welcomeAnswered: boolean
  /** The stop the coach left the tour at, to carry on from; null when not started or finished. */
  tourAt: number | null
  tourFinished: boolean
  /** The setup checklist (D17): steps done or skipped, and whether it was put away. */
  checklist: { completed: string[]; skipped: string[]; done: boolean }
}

export interface TourStatus extends TourState {
  /** Whether the coach already has athletes or programs of their own (the sample does not count). */
  hasOwnData: boolean
}

const KEY = 'tour_state'
const EMPTY: TourState = { welcomeAnswered: false, tourAt: null, tourFinished: false, checklist: { completed: [], skipped: [], done: false } }

async function read(): Promise<TourState> {
  const row = await getDb().selectFrom('app_settings').select('value').where('key', '=', KEY).executeTakeFirst()
  if (!row) return structuredClone(EMPTY)
  try {
    const p = JSON.parse(row.value) as Partial<TourState>
    return {
      welcomeAnswered: !!p.welcomeAnswered,
      tourAt: typeof p.tourAt === 'number' ? p.tourAt : null,
      tourFinished: !!p.tourFinished,
      checklist: {
        completed: Array.isArray(p.checklist?.completed) ? p.checklist!.completed.filter((s) => typeof s === 'string') : [],
        skipped: Array.isArray(p.checklist?.skipped) ? p.checklist!.skipped.filter((s) => typeof s === 'string') : [],
        done: !!p.checklist?.done,
      },
    }
  } catch {
    return structuredClone(EMPTY)
  }
}

async function hasOwnData(): Promise<boolean> {
  const db = getDb()
  const athlete = await db.selectFrom('athletes').select('id').where('is_sample', '=', 0).limit(1).executeTakeFirst()
  if (athlete) return true
  const program = await db.selectFrom('programs').select('id')
    .where((eb) => eb.or([
      eb('athlete_id', 'is', null),
      eb('athlete_id', 'not in', eb.selectFrom('athletes').select('id').where('is_sample', '=', 1)),
    ]))
    .limit(1).executeTakeFirst()
  return !!program
}

export async function tourStatus(): Promise<TourStatus> {
  return { ...(await read()), hasOwnData: await hasOwnData() }
}

export type TourChange = Partial<Omit<TourState, 'checklist'>> & { checklist?: Partial<TourState['checklist']> }

export async function updateTourState(change: TourChange): Promise<TourStatus> {
  const now = await read()
  const next: TourState = {
    welcomeAnswered: change.welcomeAnswered ?? now.welcomeAnswered,
    tourAt: change.tourAt !== undefined ? change.tourAt : now.tourAt,
    tourFinished: change.tourFinished ?? now.tourFinished,
    checklist: { ...now.checklist, ...(change.checklist ?? {}) },
  }
  const value = JSON.stringify(next)
  await getDb().insertInto('app_settings').values({ key: KEY, value })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value })).execute()
  return tourStatus()
}
