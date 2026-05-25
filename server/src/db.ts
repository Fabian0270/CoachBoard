import { Database } from 'better-sqlite3'
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
  sets: number | null
  reps: number | null
  weight: number | null
  duration: number | null
  distance: number | null
  notes: string | null
  order_index: number
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

export interface UploadedProgramTable {
  id: string
  athlete_id: string | null
  filename: string
  original_name: string
  content: string | null
  uploaded_at: string
}

export interface DB {
  athletes: AthleteTable
  programs: ProgramTable
  workouts: WorkoutTable
  exercises: ExerciseTable
  progress_records: ProgressRecordTable
  uploaded_programs: UploadedProgramTable
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
      sets INTEGER,
      reps INTEGER,
      weight REAL,
      duration INTEGER,
      distance REAL,
      notes TEXT,
      order_index INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (workout_id) REFERENCES workouts(id) ON DELETE CASCADE
    )
  `.execute(db)

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

  await sql`
    CREATE TABLE IF NOT EXISTS uploaded_programs (
      id TEXT PRIMARY KEY,
      athlete_id TEXT,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      content TEXT,
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE SET NULL
    )
  `.execute(db)
}
