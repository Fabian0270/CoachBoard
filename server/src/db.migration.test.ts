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

describe('discord_media gains the Feature 11a thumbnail columns', () => {
  it('adds the columns to a pre-11a database without disturbing existing rows', async () => {
    const thumbDbPath = join(dir, 'pre-11a.sqlite')

    // A v1.13.0-era discord_media: no thumb_path / thumb_status / duration_ms /
    // transcoded_path. Only the columns the old code actually wrote.
    const raw = new BetterSqlite3(thumbDbPath)
    raw.exec(`
      CREATE TABLE discord_users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT, avatar_url TEXT,
        athlete_id TEXT, linked_at TEXT, first_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE discord_media (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL, channel_name TEXT,
        message_id TEXT NOT NULL, attachment_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        athlete_id TEXT, workout_id TEXT, suggested_workout_id TEXT,
        filename TEXT NOT NULL, content_type TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0, width INTEGER, height INTEGER,
        message_content TEXT, posted_at TEXT NOT NULL, posted_date TEXT NOT NULL,
        source_url TEXT, local_path TEXT, sha256 TEXT,
        download_status TEXT NOT NULL DEFAULT 'pending', download_error TEXT,
        duplicate_of_id TEXT, reviewed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (message_id, attachment_id)
      );
      INSERT INTO discord_users (id, username) VALUES ('u1', 'lifter');
      INSERT INTO discord_media
        (id, channel_id, message_id, attachment_id, discord_user_id, filename,
         size_bytes, posted_at, posted_date, local_path, download_status)
      VALUES
        ('m1', 'c1', 'msg1', 'att1', 'u1', 'squat.mp4',
         42, '2026-07-03T10:00:00.000Z', '2026-07-03',
         'media/discord/2026-07/msg1_att1_squat.mp4', 'downloaded');
    `)
    const before = raw.prepare(`PRAGMA table_info(discord_media)`).all() as Array<{ name: string }>
    expect(before.map((c) => c.name)).not.toContain('thumb_path')
    raw.close()

    await initializeDatabase(thumbDbPath)
    const db = getDb()

    const after = (
      await sql<{ name: string }>`PRAGMA table_info(discord_media)`.execute(db)
    ).rows.map((c) => c.name)
    for (const col of ['thumb_path', 'thumb_status', 'duration_ms', 'transcoded_path']) {
      expect(after).toContain(col)
    }

    // The existing video survives, with the new columns defaulting to null —
    // which is what tells the client "no thumbnail attempted yet".
    const row = await db.selectFrom('discord_media').selectAll().where('id', '=', 'm1').executeTakeFirst()
    expect(row?.filename).toBe('squat.mp4')
    expect(row?.local_path).toBe('media/discord/2026-07/msg1_att1_squat.mp4')
    expect(row?.thumb_path).toBeNull()
    expect(row?.thumb_status).toBeNull()
    expect(row?.duration_ms).toBeNull()

    // And they are writable, so saveThumbnail has somewhere to land.
    await db
      .updateTable('discord_media')
      .set({ thumb_path: 'media/thumbs/2026-07/m1.jpg', thumb_status: 'ok', duration_ms: 5000 })
      .where('id', '=', 'm1')
      .execute()
    const updated = await db.selectFrom('discord_media').selectAll().where('id', '=', 'm1').executeTakeFirst()
    expect(updated?.thumb_status).toBe('ok')
    expect(updated?.duration_ms).toBe(5000)
  })
})
