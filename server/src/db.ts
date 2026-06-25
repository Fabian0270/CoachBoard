import BetterSqlite3 from 'better-sqlite3'
import { Kysely, SqliteDialect, sql } from 'kysely'
import { mkdirSync } from 'fs'
import { dirname } from 'path'

export interface AthleteTable {
  id: string
  name: string
  email: string | null
  sport: string | null
  date_of_birth: string | null
  notes: string | null
  archived: number   // 0/1 — archived athletes are hidden from the active roster
  created_at: string
  updated_at: string
}

export interface ProgramTable {
  id: string
  athlete_id: string | null  // null = unassigned (owning athlete deleted, program kept)
  name: string
  description: string | null
  start_date: string | null
  end_date: string | null
  status: string
  created_at: string
  updated_at: string
  enabled_columns: string | null
  focus: string | null
  export_layout: string | null         // JSON ExportLayoutTemplate, or null = generic export
  export_template_xlsx: string | null  // base64 of the original imported .xlsx, for high-fidelity re-fill export
}

// Opt-in reusable saved styles (the import step's "save this style" toggle).
export interface ExportStyleTable {
  id: string
  name: string
  descriptor: string            // JSON ExportLayoutTemplate
  template_xlsx: string | null  // base64 of the original .xlsx for re-fill export
  created_at: string
}

export interface WorkoutTable {
  id: string
  program_id: string
  name: string
  scheduled_date: string | null
  completed_at: string | null
  notes: string | null
  created_at: string
}

export interface ExerciseTable {
  id: string
  workout_id: string
  name: string
  sets: string | null
  reps: string | null
  weight: number | null
  duration: number | null
  distance: number | null
  notes: string | null
  order_index: number
  rest_time: string | null
  intensity: string | null
  load_used: string | null
  rpe: string | null
  group_id: string | null
  suggestion_note: string | null
}

export interface ProgressRecordTable {
  id: string
  athlete_id: string
  metric_name: string
  value: number
  unit: string | null
  recorded_at: string
  notes: string | null
}

export interface AthleteMaxTable {
  id: string
  athlete_id: string
  lift_name: string
  weight: number
  unit: string
  recorded_at: string
  notes: string | null
}

export interface PaymentTable {
  id: string
  athlete_id: string
  amount: number
  currency: string
  start_date: string | null
  paid_through: string
  paid: number
  paid_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface DB {
  athletes: AthleteTable
  programs: ProgramTable
  workouts: WorkoutTable
  exercises: ExerciseTable
  progress_records: ProgressRecordTable
  athlete_maxes: AthleteMaxTable
  payments: PaymentTable
  export_styles: ExportStyleTable
}

let _db: Kysely<DB> | null = null

export function getDb(): Kysely<DB> {
  if (!_db) throw new Error('Database not initialized — call initializeDatabase() first')
  return _db
}

export async function initializeDatabase(dbPath: string): Promise<void> {
  mkdirSync(dirname(dbPath), { recursive: true })

  const dialect = new SqliteDialect({
    database: new BetterSqlite3(dbPath),
  })

  _db = new Kysely<DB>({ dialect })

  await sql`PRAGMA foreign_keys = ON`.execute(_db)

  await sql`
    CREATE TABLE IF NOT EXISTS athletes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      sport TEXT,
      date_of_birth TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `.execute(_db)

  // athlete_id is nullable: deleting an athlete with "keep programs" detaches their
  // programs (athlete_id → NULL, status → archived) instead of cascade-deleting them,
  // so the coach can reuse them with another athlete. The FK stays ON DELETE CASCADE —
  // detach NULLs the column first, so the cascade only fires for true full deletes.
  await sql`
    CREATE TABLE IF NOT EXISTS programs (
      id TEXT PRIMARY KEY,
      athlete_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      start_date TEXT,
      end_date TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      enabled_columns TEXT,
      FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE
    )
  `.execute(_db)

  await sql`
    CREATE TABLE IF NOT EXISTS workouts (
      id TEXT PRIMARY KEY,
      program_id TEXT NOT NULL,
      name TEXT NOT NULL,
      scheduled_date TEXT,
      completed_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
    )
  `.execute(_db)

  await sql`
    CREATE TABLE IF NOT EXISTS exercises (
      id TEXT PRIMARY KEY,
      workout_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sets TEXT,
      reps TEXT,
      weight REAL,
      duration INTEGER,
      distance REAL,
      notes TEXT,
      order_index INTEGER NOT NULL DEFAULT 0,
      rest_time TEXT,
      intensity TEXT,
      load_used TEXT,
      rpe TEXT,
      FOREIGN KEY (workout_id) REFERENCES workouts(id) ON DELETE CASCADE
    )
  `.execute(_db)

  const addColumnIfMissing = async (table: string, column: string, type: string): Promise<void> => {
    const result = await sql<{ name: string }>`PRAGMA table_info(${sql.raw(table)})`.execute(_db!)
    const exists = result.rows.some((row) => row.name === column)
    if (!exists) {
      await sql`ALTER TABLE ${sql.raw(table)} ADD COLUMN ${sql.raw(column)} ${sql.raw(type)}`.execute(_db!)
    }
  }

  await sql`CREATE INDEX IF NOT EXISTS idx_programs_athlete_id ON programs(athlete_id)`.execute(_db)
  await sql`CREATE INDEX IF NOT EXISTS idx_workouts_program_id ON workouts(program_id)`.execute(_db)
  await sql`CREATE INDEX IF NOT EXISTS idx_exercises_workout_id ON exercises(workout_id)`.execute(_db)

  await addColumnIfMissing('athletes', 'archived', 'INTEGER NOT NULL DEFAULT 0')
  await addColumnIfMissing('programs', 'enabled_columns', 'TEXT')
  await addColumnIfMissing('programs', 'focus', 'TEXT')
  await addColumnIfMissing('programs', 'export_layout', 'TEXT')
  await addColumnIfMissing('programs', 'export_template_xlsx', 'TEXT')

  // Databases created before the "keep programs on athlete delete" feature made
  // `programs.athlete_id` NOT NULL. Dropping a NOT NULL constraint in SQLite requires
  // a table rebuild. Done only when needed (idempotent), with foreign keys disabled
  // around the swap so DROP TABLE doesn't cascade-delete workouts. All columns are
  // guaranteed present by the ALTERs above.
  const programCols = (
    await sql<{ name: string; notnull: number }>`PRAGMA table_info(programs)`.execute(_db)
  ).rows
  const athleteIdCol = programCols.find((c) => c.name === 'athlete_id')
  if (athleteIdCol && Number(athleteIdCol.notnull) === 1) {
    await sql`PRAGMA foreign_keys = OFF`.execute(_db)
    await _db.transaction().execute(async (trx) => {
      await sql`
        CREATE TABLE programs_new (
          id TEXT PRIMARY KEY,
          athlete_id TEXT,
          name TEXT NOT NULL,
          description TEXT,
          start_date TEXT,
          end_date TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          enabled_columns TEXT,
          focus TEXT,
          export_layout TEXT,
          export_template_xlsx TEXT,
          FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE
        )
      `.execute(trx)
      await sql`
        INSERT INTO programs_new
          (id, athlete_id, name, description, start_date, end_date, status,
           created_at, updated_at, enabled_columns, focus, export_layout, export_template_xlsx)
        SELECT
          id, athlete_id, name, description, start_date, end_date, status,
          created_at, updated_at, enabled_columns, focus, export_layout, export_template_xlsx
        FROM programs
      `.execute(trx)
      await sql`DROP TABLE programs`.execute(trx)
      await sql`ALTER TABLE programs_new RENAME TO programs`.execute(trx)
      await sql`CREATE INDEX IF NOT EXISTS idx_programs_athlete_id ON programs(athlete_id)`.execute(trx)
    })
    await sql`PRAGMA foreign_keys = ON`.execute(_db)
  }
  await addColumnIfMissing('exercises', 'rest_time', 'TEXT')
  await addColumnIfMissing('exercises', 'intensity', 'TEXT')
  await addColumnIfMissing('exercises', 'load_used', 'TEXT')
  await addColumnIfMissing('exercises', 'rpe', 'TEXT')
  await addColumnIfMissing('exercises', 'group_id', 'TEXT')
  await addColumnIfMissing('exercises', 'suggestion_note', 'TEXT')

  await sql`
    CREATE TABLE IF NOT EXISTS progress_records (
      id TEXT PRIMARY KEY,
      athlete_id TEXT NOT NULL,
      metric_name TEXT NOT NULL,
      value REAL NOT NULL,
      unit TEXT,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      notes TEXT,
      FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE
    )
  `.execute(_db)

  await sql`CREATE INDEX IF NOT EXISTS idx_progress_athlete_id ON progress_records(athlete_id)`.execute(_db)

  await sql`
    CREATE TABLE IF NOT EXISTS athlete_maxes (
      id TEXT PRIMARY KEY,
      athlete_id TEXT NOT NULL,
      lift_name TEXT NOT NULL,
      weight REAL NOT NULL,
      unit TEXT NOT NULL DEFAULT 'kg',
      recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
      notes TEXT,
      FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE
    )
  `.execute(_db)

  await sql`CREATE INDEX IF NOT EXISTS idx_athlete_maxes_athlete_id ON athlete_maxes(athlete_id)`.execute(_db)

  await sql`
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      athlete_id TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      start_date TEXT,
      paid_through TEXT NOT NULL,
      paid INTEGER NOT NULL DEFAULT 0,
      paid_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE
    )
  `.execute(_db)

  // Migrate a pre-1.8.0 dev payments table (period_start/period_end/due_date,
  // with due_date NOT NULL) to the start_date + paid_through model:
  //  1. add the new columns,
  //  2. backfill them from the old date columns,
  //  3. drop the legacy columns — crucially removing the old NOT NULL due_date,
  //     which would otherwise reject inserts that no longer set it.
  await addColumnIfMissing('payments', 'paid_through', 'TEXT')
  await addColumnIfMissing('payments', 'start_date', 'TEXT')
  const paymentCols = (
    await sql<{ name: string }>`PRAGMA table_info(payments)`.execute(_db)
  ).rows.map((r) => r.name)

  const endSources = ['period_end', 'due_date'].filter((c) => paymentCols.includes(c))
  if (endSources.length > 0) {
    const coalesce = ['paid_through', ...endSources, 'substr(created_at, 1, 10)'].join(', ')
    await sql
      .raw(`UPDATE payments SET paid_through = COALESCE(${coalesce}) WHERE paid_through IS NULL`)
      .execute(_db)
  }
  if (paymentCols.includes('period_start')) {
    await sql
      .raw('UPDATE payments SET start_date = COALESCE(start_date, period_start) WHERE start_date IS NULL')
      .execute(_db)
  }
  for (const col of ['period_start', 'period_end', 'due_date']) {
    if (paymentCols.includes(col)) {
      await sql.raw(`ALTER TABLE payments DROP COLUMN ${col}`).execute(_db)
    }
  }

  await sql`CREATE INDEX IF NOT EXISTS idx_payments_athlete_id ON payments(athlete_id)`.execute(_db)

  await sql`
    CREATE TABLE IF NOT EXISTS export_styles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      descriptor TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `.execute(_db)
  await addColumnIfMissing('export_styles', 'template_xlsx', 'TEXT')
}
