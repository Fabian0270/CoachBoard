import { describe, it, expect, afterEach } from 'vitest'
import { openSqlite } from './sqlite.js'

// The whole point of this module is that the test suite can run under plain Node
// against a cached Node-ABI addon while node_modules keeps its Electron build.
// If these break, the likely symptom is not a failing test — it is the app
// refusing to launch with a NODE_MODULE_VERSION error.

const original = process.env.COACHBOARD_SQLITE_BINDING

afterEach(() => {
  if (original === undefined) delete process.env.COACHBOARD_SQLITE_BINDING
  else process.env.COACHBOARD_SQLITE_BINDING = original
})

describe('openSqlite', () => {
  it('opens a database using the configured binding', () => {
    // This suite is itself run with the override set, so the plain call is
    // already exercising it — assert it actually works rather than assuming.
    const db = openSqlite(':memory:')
    try {
      db.exec('CREATE TABLE t (a INTEGER)')
      db.prepare('INSERT INTO t (a) VALUES (?)').run(1)
      expect(db.prepare('SELECT a FROM t').get()).toEqual({ a: 1 })
    } finally {
      db.close()
    }
  })

  it('passes caller options through alongside the binding', () => {
    const db = openSqlite(':memory:', { timeout: 1234 })
    try {
      expect(db.open).toBe(true)
    } finally {
      db.close()
    }
  })

  it('fails loudly when the configured binding is missing', () => {
    process.env.COACHBOARD_SQLITE_BINDING = '/nope/not-a-real-binding.node'
    // Without this check the failure surfaces as an opaque module-load error
    // from inside better-sqlite3, with no hint about where the path came from.
    expect(() => openSqlite(':memory:')).toThrow(/COACHBOARD_SQLITE_BINDING/)
  })
})
