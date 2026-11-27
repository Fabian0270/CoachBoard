import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomBytes } from 'crypto'
import { initializeDatabase, getDb, getSqlite } from './db.js'
import { openSqlite } from './sqlite.js'
import { loadTemplate } from './services/templateBlobStore.js'

// The 1.17.0 move of imported workbooks out of programs/export_styles and into
// template_blobs. It is the one step in the release that rewrites a coach's
// existing data, so every test here starts from a real pre-1.17 database file
// and upgrades it the way the app does: by opening it.

vi.spyOn(console, 'log').mockImplementation(() => {})

// Each test migrates a real database FILE: dozens of statements, each making
// and deleting a journal file. On a dev machine that is ~0.3 s a test; on
// GitHub's Windows runners (Defender scans every new file) it ran past the 5 s
// default and the whole server-windows job went red. A real hang still fails.
vi.setConfig({ testTimeout: 60_000 })

let dir = ''
let dbPath = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-templates-'))
  dbPath = path.join(dir, 'coachboard.sqlite')
})

afterEach(async () => {
  try {
    await getDb().destroy()
  } catch {
    /* already closed */
  }
  fs.rmSync(dir, { recursive: true, force: true })
})

/** A workbook stand-in: random bytes, so SQLite cannot compress the duplicates away. */
const workbook = (bytes: number): string => randomBytes(bytes).toString('base64')

interface Legacy {
  /** Pre-"keep programs" databases had athlete_id NOT NULL, which forces a table rebuild. */
  athleteIdNotNull?: boolean
  /** Extra SQL run after the schema, before the data. */
  extraSql?: string
}

/**
 * The schema as 1.16.x left it, with one athlete, `copies` programs sharing one
 * workbook (as derived programs and drafts did), one program with a workbook of
 * its own, one with none, and a saved style holding the shared workbook again.
 */
function writeLegacyDatabase(shared: string, own: string, copies: number, opts: Legacy = {}): void {
  const db = openSqlite(dbPath)
  db.exec(`
    CREATE TABLE athletes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, sport TEXT, date_of_birth TEXT, notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived INTEGER NOT NULL DEFAULT 0, weight_class TEXT, height_cm INTEGER
    );
    CREATE TABLE programs (
      id TEXT PRIMARY KEY,
      athlete_id TEXT ${opts.athleteIdNotNull ? 'NOT NULL' : ''},
      name TEXT NOT NULL, description TEXT, start_date TEXT, end_date TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      enabled_columns TEXT, focus TEXT, export_layout TEXT, export_template_xlsx TEXT,
      builtin_template TEXT DEFAULT 'coachboard'
      ${opts.athleteIdNotNull ? '' : ', bookmarked INTEGER NOT NULL DEFAULT 0'},
      FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE
    );
    CREATE TABLE workouts (
      id TEXT PRIMARY KEY, program_id TEXT NOT NULL, name TEXT NOT NULL, scheduled_date TEXT,
      completed_at TEXT, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
    );
    CREATE TABLE exercises (
      id TEXT PRIMARY KEY, workout_id TEXT NOT NULL, name TEXT NOT NULL, sets TEXT, reps TEXT,
      weight REAL, duration INTEGER, distance REAL, notes TEXT, order_index INTEGER NOT NULL DEFAULT 0,
      rest_time TEXT, intensity TEXT, load_used TEXT, rpe TEXT,
      FOREIGN KEY (workout_id) REFERENCES workouts(id) ON DELETE CASCADE
    );
    CREATE TABLE export_styles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, descriptor TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), template_xlsx TEXT
    );
    ${opts.extraSql ?? ''}
  `)
  db.prepare("INSERT INTO athletes (id, name) VALUES ('a1', 'Legacy Lifter')").run()
  const program = db.prepare('INSERT INTO programs (id, athlete_id, name, export_template_xlsx) VALUES (?, ?, ?, ?)')
  const workout = db.prepare("INSERT INTO workouts (id, program_id, name) VALUES (?, ?, 'Day 1')")
  for (let i = 0; i < copies; i++) {
    program.run(`shared-${i}`, 'a1', `Block ${i + 1}`, shared)
    workout.run(`w-${i}`, `shared-${i}`)
  }
  program.run('own', 'a1', 'Own Import', own)
  program.run('plain', 'a1', 'No Template', null)
  db.prepare("INSERT INTO export_styles (id, name, descriptor, template_xlsx) VALUES ('s1', 'Saved', '{}', ?)").run(shared)
  db.close()
}

const columnsOf = (table: string): string[] =>
  (getSqlite().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

const shaOf = async (id: string) =>
  (await getDb().selectFrom('programs').select('export_template_sha').where('id', '=', id).executeTakeFirstOrThrow())
    .export_template_sha

describe('moving stored workbooks into template_blobs', () => {
  it('keeps every workbook, stores each distinct one once, and drops the old columns', async () => {
    const shared = workbook(200_000)
    const own = workbook(50_000)
    writeLegacyDatabase(shared, own, 12)

    await initializeDatabase(dbPath)

    for (let i = 0; i < 12; i++) expect(await loadTemplate(await shaOf(`shared-${i}`))).toBe(shared)
    expect(await loadTemplate(await shaOf('own'))).toBe(own)
    expect(await shaOf('plain')).toBeNull()

    const style = await getDb().selectFrom('export_styles').select('template_sha').executeTakeFirstOrThrow()
    expect(style.template_sha).toBe(await shaOf('shared-0'))

    const blobs = await getDb().selectFrom('template_blobs').select('sha256').execute()
    expect(blobs).toHaveLength(2)

    expect(columnsOf('programs')).not.toContain('export_template_xlsx')
    expect(columnsOf('export_styles')).not.toContain('template_xlsx')
  })

  it('never fires the workouts cascade', async () => {
    writeLegacyDatabase(workbook(1_000), workbook(1_000), 5)
    await initializeDatabase(dbPath)
    const workouts = await getDb().selectFrom('workouts').select('id').execute()
    expect(workouts).toHaveLength(5)
  })

  it('actually shrinks the file', async () => {
    writeLegacyDatabase(workbook(200_000), workbook(1_000), 12)
    const before = fs.statSync(dbPath).size

    await initializeDatabase(dbPath)
    await getDb().destroy()
    const after = fs.statSync(dbPath).size

    // Twelve base64 copies (~3.2 MB) become one raw copy (~200 KB).
    expect(before).toBeGreaterThan(3_000_000)
    expect(after).toBeLessThan(before / 5)
  })

  it('is a no-op on the next launch, and does not bring the old column back', async () => {
    const shared = workbook(10_000)
    writeLegacyDatabase(shared, workbook(1_000), 3)
    await initializeDatabase(dbPath)
    const sha = await shaOf('shared-0')
    await getDb().destroy()

    await initializeDatabase(dbPath)
    expect(columnsOf('programs')).not.toContain('export_template_xlsx')
    expect(columnsOf('export_styles')).not.toContain('template_xlsx')
    expect(await shaOf('shared-0')).toBe(sha)
    expect(await loadTemplate(sha)).toBe(shared)
  })

  it('carries the workbooks through the old athlete_id rebuild', async () => {
    const shared = workbook(10_000)
    writeLegacyDatabase(shared, workbook(1_000), 2, { athleteIdNotNull: true })

    await initializeDatabase(dbPath)

    const athleteId = (getSqlite().prepare('PRAGMA table_info(programs)').all() as { name: string; notnull: number }[])
      .find((c) => c.name === 'athlete_id')!
    expect(Number(athleteId.notnull)).toBe(0)
    expect(await loadTemplate(await shaOf('shared-1'))).toBe(shared)
    expect(await getDb().selectFrom('workouts').select('id').execute()).toHaveLength(2)
  })

  it('leaves the database untouched when the move fails partway', async () => {
    const shared = workbook(10_000)
    // template_blobs already exists (CREATE IF NOT EXISTS keeps it) with a
    // trigger that refuses the second workbook, so the first has been written
    // when the failure comes.
    writeLegacyDatabase(shared, workbook(1_000), 3, {
      extraSql: `
        CREATE TABLE template_blobs (
          sha256 TEXT PRIMARY KEY, data BLOB NOT NULL, size_bytes INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TRIGGER refuse_second BEFORE INSERT ON template_blobs
          WHEN (SELECT COUNT(*) FROM template_blobs) >= 1
          BEGIN SELECT RAISE(ABORT, 'disk full, say'); END;
      `,
    })

    await expect(initializeDatabase(dbPath)).rejects.toThrow(/disk full/)
    try {
      getSqlite().close()
    } catch {
      /* already closed */
    }

    const db = openSqlite(dbPath)
    try {
      const rows = db.prepare('SELECT id, export_template_xlsx FROM programs WHERE export_template_xlsx IS NOT NULL').all()
      expect(rows).toHaveLength(4)
      expect(db.prepare('SELECT COUNT(*) FROM template_blobs').pluck().get()).toBe(0)
      expect(db.prepare('SELECT COUNT(*) FROM programs WHERE export_template_sha IS NOT NULL').pluck().get()).toBe(0)
    } finally {
      db.close()
    }
  })

  it('deletes workbooks nothing points at any more on the next launch', async () => {
    writeLegacyDatabase(workbook(1_000), workbook(1_000), 2)
    await initializeDatabase(dbPath)
    const ownSha = await shaOf('own')
    await getDb().deleteFrom('programs').where('id', '=', 'own').execute()
    await getDb().destroy()

    await initializeDatabase(dbPath)
    expect(await loadTemplate(ownSha)).toBeNull()
    // The shared one is still used by programs and the style.
    expect(await loadTemplate(await shaOf('shared-0'))).not.toBeNull()
  })
})
