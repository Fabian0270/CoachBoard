import { afterAll, describe, it, expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { sql } from 'kysely'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { initializeDatabase, getDb } from './db.js'

// Simulate a pre-feature database where programs.athlete_id was NOT NULL, then run
// initializeDatabase over it and confirm the nullable migration preserves data.
const dir = mkdtempSync(join(tmpdir(), 'coachboard-mig-'))
const dbPath = join(dir, 'old.sqlite')

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
})

describe('programs.athlete_id NOT NULL → nullable migration', () => {
  it('drops the NOT NULL constraint while preserving programs and their children', async () => {
    // Build the legacy schema by hand (athlete_id NOT NULL, no focus/export columns).
    const raw = new BetterSqlite3(dbPath)
    raw.pragma('foreign_keys = ON')
    raw.exec(`
      CREATE TABLE athletes (id TEXT PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE programs (
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
      );
      CREATE TABLE workouts (
        id TEXT PRIMARY KEY, program_id TEXT NOT NULL, name TEXT NOT NULL,
        scheduled_date TEXT, completed_at TEXT, notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
      );
      INSERT INTO athletes (id, name) VALUES ('a1', 'Legacy Larry');
      INSERT INTO programs (id, athlete_id, name) VALUES ('p1', 'a1', 'Old block');
      INSERT INTO workouts (id, program_id, name) VALUES ('w1', 'p1', 'Day 1');
    `)
    // Sanity: the constraint really is NOT NULL before migrating.
    const before = raw.prepare(`PRAGMA table_info(programs)`).all() as Array<{ name: string; notnull: number }>
    expect(before.find((c) => c.name === 'athlete_id')?.notnull).toBe(1)
    raw.close()

    // Run the app's initializer over the legacy file — triggers the rebuild.
    await initializeDatabase(dbPath)
    const db = getDb()

    // Constraint is gone…
    const after = (
      await sql<{ name: string; notnull: number }>`PRAGMA table_info(programs)`.execute(db)
    ).rows
    expect(after.find((c) => c.name === 'athlete_id')?.notnull).toBe(0)

    // …data preserved, with the FK relationship intact.
    const program = await db.selectFrom('programs').selectAll().where('id', '=', 'p1').executeTakeFirst()
    expect(program?.athlete_id).toBe('a1')
    expect(program?.name).toBe('Old block')
    const workout = await db.selectFrom('workouts').selectAll().where('id', '=', 'w1').executeTakeFirst()
    expect(workout?.program_id).toBe('p1')

    // The column now genuinely accepts NULL.
    await db.updateTable('programs').set({ athlete_id: null }).where('id', '=', 'p1').execute()
    const detached = await db.selectFrom('programs').selectAll().where('id', '=', 'p1').executeTakeFirst()
    expect(detached?.athlete_id).toBeNull()
  })
})
