import { v4 as uuidv4 } from 'uuid'
import { getDb } from '../../db.js'
import { findAthleteById } from '../athleteService.js'
import type {
  ExternalExerciseRow,
  ExternalImportCommitResult,
  ExportLayoutTemplate,
} from 'coachboard-shared'

// ---------------------------------------------------------------------------
// Commit (Feature 4b) — materialise parsed rows into a real, editable program.
//
// Each detected (week, day) block becomes one workout placed on the calendar
// in order from the start Monday, so the native day editor renders every day
// in sequence. Exercise order is preserved; consecutive same-name rows share a
// group_id so multi-set/carry-forward rows stay grouped like native sets.
// ---------------------------------------------------------------------------

const toIso = (d: Date): string => d.toISOString().slice(0, 10)

function mondayOf(isoDate: string): Date {
  const [y, m, d] = isoDate.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const dow = date.getUTCDay()
  const offset = dow === 0 ? -6 : 1 - dow
  date.setUTCDate(date.getUTCDate() + offset)
  return date
}

function addDays(start: Date, days: number): string {
  const d = new Date(start)
  d.setUTCDate(start.getUTCDate() + days)
  return toIso(d)
}

const sameName = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

export async function commitExternalProgram(
  exercises: ExternalExerciseRow[],
  meta: {
    athleteId: string
    name: string
    status: string
    startDate?: string | null
    weeks: number
    focus?: string | null
    exportLayout?: ExportLayoutTemplate | null
    templateXlsx?: string | null   // base64 of the original file, for re-fill export
  },
): Promise<ExternalImportCommitResult> {
  const athlete = await findAthleteById(meta.athleteId)
  if (!athlete) throw new Error(`Athlete not found: ${meta.athleteId}`)

  // Archived historical imports may omit a start date — fall back to this week's
  // Monday so days still land on the calendar in order (the program is hidden
  // from the active roster anyway, and the relative week structure is preserved).
  const startMonday = mondayOf(meta.startDate || toIso(new Date()))
  const weeks = Math.max(meta.weeks, 1)
  const now = new Date().toISOString()
  const programId = uuidv4()

  // Group rows by (week, day) block, preserving in-sheet order.
  const blocks = new Map<string, ExternalExerciseRow[]>()
  for (const ex of exercises) {
    const key = `${ex.weekIndex}-${ex.dayIndex}`
    const list = blocks.get(key) ?? []
    list.push(ex)
    blocks.set(key, list)
  }

  const db = getDb()
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('programs')
      .values({
        id: programId,
        athlete_id: meta.athleteId,
        name: meta.name,
        description: null,
        start_date: toIso(startMonday),
        end_date: addDays(startMonday, weeks * 7 - 1),
        status: meta.status,
        enabled_columns: null,
        focus: meta.focus ?? null,
        export_layout: meta.exportLayout ? JSON.stringify(meta.exportLayout) : null,
        export_template_xlsx: meta.templateXlsx ?? null,
        created_at: now,
        updated_at: now,
      })
      .execute()

    for (const rows of blocks.values()) {
      const { weekIndex, dayIndex } = rows[0]
      const workoutDate = addDays(startMonday, weekIndex * 7 + Math.min(dayIndex, 6))
      const workoutId = uuidv4()

      await trx
        .insertInto('workouts')
        .values({
          id: workoutId,
          program_id: programId,
          name: workoutDate,
          scheduled_date: workoutDate,
          notes: null,
          created_at: now,
        })
        .execute()

      let groupId: string | null = null
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const prev = i > 0 ? rows[i - 1] : null
        const next = i < rows.length - 1 ? rows[i + 1] : null

        // Start a new group when this row begins a run of same-named rows.
        if (prev && sameName(prev.name, row.name)) {
          // continue current group
        } else if (next && sameName(next.name, row.name)) {
          groupId = uuidv4()
        } else {
          groupId = null
        }

        await trx
          .insertInto('exercises')
          .values({
            id: uuidv4(),
            workout_id: workoutId,
            name: row.name,
            sets: row.sets,
            reps: row.reps,
            weight: row.loadCap ?? null,
            duration: null,
            distance: null,
            notes: null,
            order_index: i,
            rest_time: row.restTime ?? null,
            intensity: row.intensity ?? null,
            load_used: row.load,
            rpe: row.rpe,
            group_id: groupId,
            suggestion_note: null,
          })
          .execute()
      }
    }
  })

  return { programId }
}
