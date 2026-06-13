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
  created_at: string
  updated_at: string
}

export interface ProgramTable {
  id: string
  athlete_id: string
  name: string
  description: string | null
  start_date: string | null
  end_date: string | null
  status: string
  created_at: string
  updated_at: string
  enabled_columns: string | null
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

export interface DB {
  athletes: AthleteTable
  programs: ProgramTable
  workouts: WorkoutTable
  exercises: ExerciseTable
  progress_records: ProgressRecordTable
  athlete_maxes: AthleteMaxTable
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

  await sql`
    CREATE TABLE IF NOT EXISTS programs (
      id TEXT PRIMARY KEY,
      athlete_id TEXT NOT NULL,
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

  await addColumnIfMissing('programs', 'enabled_columns', 'TEXT')
  await addColumnIfMissing('exercises', 'rest_time', 'TEXT')
  await addColumnIfMissing('exercises', 'intensity', 'TEXT')
  await addColumnIfMissing('exercises', 'load_used', 'TEXT')
  await addColumnIfMissing('exercises', 'rpe', 'TEXT')

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
}
