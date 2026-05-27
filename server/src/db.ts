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

export interface DB {
  athletes: AthleteTable
  programs: ProgramTable
  workouts: WorkoutTable
  exercises: ExerciseTable
  progress_records: ProgressRecordTable
}

const DB_PATH = '/home/app/data/database.sqlite'

mkdirSync(dirname(DB_PATH), { recursive: true })

const dialect = new SqliteDialect({
  database: new BetterSqlite3(DB_PATH, { verbose: console.log }),
})

export const db = new Kysely<DB>({ dialect })

export async function initializeDatabase(): Promise<void> {
  await sql`PRAGMA foreign_keys = ON`.execute(db)

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
  `.execute(db)

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
  `.execute(db)

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
  `.execute(db)

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
  `.execute(db)

  const addColumnIfMissing = async (table: string, column: string, type: string): Promise<void> => {
    try {
      await sql`ALTER TABLE ${sql.raw(table)} ADD COLUMN ${sql.raw(column)} ${sql.raw(type)}`.execute(db)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.toLowerCase().includes('duplicate column')) throw e
    }
  }

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
  `.execute(db)

}
