import type BetterSqlite3 from 'better-sqlite3'
import { Kysely, SqliteDialect, sql, type Generated } from 'kysely'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { openSqlite } from './sqlite.js'
import { applyPendingRestore } from './services/pendingRestore.js'

export interface AthleteTable {
  id: string
  name: string
  email: string | null
  sport: string | null
  weight_class: string | null   // powerlifting weight class, e.g. '83' (kg); free where not applicable
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
  builtin_template: string | null      // chosen starter look ('coachboard' | 'minimal' | 'modern') when no imported style
  // 0/1 — coach favorited this program for reuse. Generated: has a SQL default,
  // so existing inserts that predate this column don't need to set it.
  bookmarked: Generated<number>
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

// ---------------------------------------------------------------------------
// Discord integration (two-way sync). Discord snowflake ids are stored as TEXT
// natural keys; app-created rows use UUID v4 like the rest of the schema.
// The bot token itself is NOT in SQLite — see discordSettingsService.
// ---------------------------------------------------------------------------

export interface DiscordChannelTable {
  id: string                    // Discord channel snowflake
  kind: string                  // 'guild' | 'dm'
  guild_id: string | null       // null for DM channels
  name: string                  // '#form-checks' or 'DM · username'
  guild_name: string | null
  dm_user_id: string | null     // set when kind='dm' — the linked athlete's Discord user
  enabled: number               // 0/1 coach toggle
  last_message_id: string | null // sync cursor (snowflake); pre-seeded by history window
  last_synced_at: string | null
  sync_error: string | null     // 'forbidden' | 'not_found' | null
  created_at: string
}

export interface DiscordUserTable {
  id: string                    // Discord user snowflake
  username: string
  display_name: string | null
  avatar_url: string | null
  athlete_id: string | null     // null = unlinked; several users may map to one athlete
  linked_at: string | null
  first_seen_at: string
}

export interface DiscordMediaTable {
  id: string                    // uuid v4
  channel_id: string            // opaque reference — no FK, media outlives channel config
  channel_name: string | null   // cached at sync time for display
  message_id: string
  attachment_id: string
  discord_user_id: string
  athlete_id: string | null            // denormalized from user link; null = unmatched
  workout_id: string | null            // CONFIRMED attach (coach clicked confirm)
  suggested_workout_id: string | null  // suggestion only, never shown as attached
  filename: string
  content_type: string | null
  size_bytes: number
  width: number | null
  height: number | null
  message_content: string | null       // caption
  posted_at: string                    // ISO timestamp from Discord
  posted_date: string                  // YYYY-MM-DD (UTC) for date matching
  source_url: string | null            // CDN URL at fetch time (expires ~24h)
  local_path: string | null            // relative to userData, forward slashes
  sha256: string | null
  download_status: string              // 'pending' | 'downloaded' | 'failed' | 'skipped_too_large'
  download_error: string | null        // 'network' | 'expired' | 'message_deleted' | 'http_4xx'
  duplicate_of_id: string | null       // informational sha256-dup marker (both files kept)
  reviewed: number                     // 0/1
  created_at: string
}

export interface DiscordSentMessageTable {
  id: string                    // uuid v4
  channel_id: string
  kind: string                  // 'channel' | 'dm'
  discord_user_id: string | null // recipient (DM) or original poster (reply)
  related_media_id: string | null
  reply_to_message_id: string | null
  content: string
  status: string                // 'sent' | 'failed'
  error: string | null
  discord_message_id: string | null // Discord's id for the sent message
  created_at: string
}

// Inbound text messages athletes DM to the bot (the athlete side of the
// conversation). Outbound lives in discord_sent_messages; the two are unioned
// per athlete for the Messages view. DM-only by design.
export interface DiscordInboundMessageTable {
  id: string                    // uuid v4
  discord_message_id: string    // Discord snowflake — UNIQUE for idempotent re-sync
  channel_id: string            // the DM channel
  discord_user_id: string       // the athlete's Discord account
  athlete_id: string | null     // denormalized from the user link; ON DELETE SET NULL
  content: string
  posted_at: string             // Discord message timestamp
  read: number                  // 0/1 — cleared when the coach opens the thread
  created_at: string
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
  discord_channels: DiscordChannelTable
  discord_users: DiscordUserTable
  discord_media: DiscordMediaTable
  discord_sent_messages: DiscordSentMessageTable
  discord_inbound_messages: DiscordInboundMessageTable
}

let _db: Kysely<DB> | null = null
let _sqlite: BetterSqlite3.Database | null = null
let _dbPath = ''

export function getDb(): Kysely<DB> {
  if (!_db) throw new Error('Database not initialized — call initializeDatabase() first')
  return _db
}

/**
 * The raw better-sqlite3 handle underneath Kysely. Needed for the online backup
 * API, which is the only way to copy the database consistently while the app is
 * running — a plain file copy can catch a half-written page.
 */
export function getSqlite(): BetterSqlite3.Database {
  if (!_sqlite) throw new Error('Database not initialized — call initializeDatabase() first')
  return _sqlite
}

/** Where the live database file is. ':memory:' under test. */
export function getDatabasePath(): string {
  return _dbPath
}

export async function initializeDatabase(dbPath: string): Promise<void> {
  mkdirSync(dirname(dbPath), { recursive: true })

  // A restore staged by the coach is swapped in here, before anything opens the
  // file — SQLite holds it open for the whole session, so this is the only safe
  // moment to replace it.
  if (applyPendingRestore(dbPath)) {
    console.log('Applied a staged database restore')
  }

  _sqlite = openSqlite(dbPath)
  _dbPath = dbPath

  const dialect = new SqliteDialect({
    database: _sqlite,
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
  await addColumnIfMissing('athletes', 'weight_class', 'TEXT')
  await addColumnIfMissing('programs', 'enabled_columns', 'TEXT')
  await addColumnIfMissing('programs', 'focus', 'TEXT')
  await addColumnIfMissing('programs', 'export_layout', 'TEXT')
  await addColumnIfMissing('programs', 'export_template_xlsx', 'TEXT')
  await addColumnIfMissing('programs', 'builtin_template', "TEXT DEFAULT 'coachboard'")

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
          builtin_template TEXT DEFAULT 'coachboard',
          FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE CASCADE
        )
      `.execute(trx)
      await sql`
        INSERT INTO programs_new
          (id, athlete_id, name, description, start_date, end_date, status,
           created_at, updated_at, enabled_columns, focus, export_layout, export_template_xlsx, builtin_template)
        SELECT
          id, athlete_id, name, description, start_date, end_date, status,
          created_at, updated_at, enabled_columns, focus, export_layout, export_template_xlsx, builtin_template
        FROM programs
      `.execute(trx)
      await sql`DROP TABLE programs`.execute(trx)
      await sql`ALTER TABLE programs_new RENAME TO programs`.execute(trx)
      await sql`CREATE INDEX IF NOT EXISTS idx_programs_athlete_id ON programs(athlete_id)`.execute(trx)
    })
    await sql`PRAGMA foreign_keys = ON`.execute(_db)
  }
  // Added after the rebuild so it lands on the final programs table in both the
  // new-DB and legacy-rebuild paths.
  await addColumnIfMissing('programs', 'bookmarked', 'INTEGER NOT NULL DEFAULT 0')
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

  // --- Discord integration -------------------------------------------------
  // ON DELETE SET NULL throughout: deleting an athlete returns their Discord
  // media to the unmatched queue instead of destroying it.

  await sql`
    CREATE TABLE IF NOT EXISTS discord_channels (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'guild',
      guild_id TEXT,
      name TEXT NOT NULL,
      guild_name TEXT,
      dm_user_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_message_id TEXT,
      last_synced_at TEXT,
      sync_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `.execute(_db)

  await sql`
    CREATE TABLE IF NOT EXISTS discord_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      athlete_id TEXT,
      linked_at TEXT,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE SET NULL
    )
  `.execute(_db)

  await sql`
    CREATE TABLE IF NOT EXISTS discord_media (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      message_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      discord_user_id TEXT NOT NULL,
      athlete_id TEXT,
      workout_id TEXT,
      suggested_workout_id TEXT,
      filename TEXT NOT NULL,
      content_type TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      message_content TEXT,
      posted_at TEXT NOT NULL,
      posted_date TEXT NOT NULL,
      source_url TEXT,
      local_path TEXT,
      sha256 TEXT,
      download_status TEXT NOT NULL DEFAULT 'pending',
      download_error TEXT,
      duplicate_of_id TEXT,
      reviewed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (message_id, attachment_id),
      FOREIGN KEY (discord_user_id) REFERENCES discord_users(id),
      FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE SET NULL,
      FOREIGN KEY (workout_id) REFERENCES workouts(id) ON DELETE SET NULL,
      FOREIGN KEY (suggested_workout_id) REFERENCES workouts(id) ON DELETE SET NULL
    )
  `.execute(_db)

  await sql`
    CREATE TABLE IF NOT EXISTS discord_sent_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      discord_user_id TEXT,
      related_media_id TEXT,
      reply_to_message_id TEXT,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      discord_message_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (related_media_id) REFERENCES discord_media(id) ON DELETE SET NULL
    )
  `.execute(_db)

  await sql`
    CREATE TABLE IF NOT EXISTS discord_inbound_messages (
      id TEXT PRIMARY KEY,
      discord_message_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      discord_user_id TEXT NOT NULL,
      athlete_id TEXT,
      content TEXT NOT NULL,
      posted_at TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (discord_message_id),
      FOREIGN KEY (athlete_id) REFERENCES athletes(id) ON DELETE SET NULL
    )
  `.execute(_db)

  await sql`CREATE INDEX IF NOT EXISTS idx_discord_media_athlete ON discord_media(athlete_id)`.execute(_db)
  await sql`CREATE INDEX IF NOT EXISTS idx_discord_media_user ON discord_media(discord_user_id)`.execute(_db)
  await sql`CREATE INDEX IF NOT EXISTS idx_discord_media_reviewed ON discord_media(reviewed)`.execute(_db)
  await sql`CREATE INDEX IF NOT EXISTS idx_discord_media_status ON discord_media(download_status)`.execute(_db)
  await sql`CREATE INDEX IF NOT EXISTS idx_discord_media_sha256 ON discord_media(sha256)`.execute(_db)
  await sql`CREATE INDEX IF NOT EXISTS idx_discord_media_posted ON discord_media(posted_at)`.execute(_db)
  await sql`CREATE INDEX IF NOT EXISTS idx_discord_media_workout ON discord_media(workout_id)`.execute(_db)
  await sql`CREATE INDEX IF NOT EXISTS idx_discord_users_athlete ON discord_users(athlete_id)`.execute(_db)
  await sql`CREATE INDEX IF NOT EXISTS idx_discord_sent_media ON discord_sent_messages(related_media_id)`.execute(_db)
  await sql`CREATE INDEX IF NOT EXISTS idx_discord_sent_user ON discord_sent_messages(discord_user_id)`.execute(_db)
  await sql`CREATE INDEX IF NOT EXISTS idx_discord_inbound_athlete ON discord_inbound_messages(athlete_id)`.execute(_db)
  await sql`CREATE INDEX IF NOT EXISTS idx_discord_inbound_read ON discord_inbound_messages(read)`.execute(_db)
  await sql`CREATE INDEX IF NOT EXISTS idx_discord_inbound_user ON discord_inbound_messages(discord_user_id)`.execute(_db)
}
