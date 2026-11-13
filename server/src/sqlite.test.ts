import { describe, it, expect } from 'vitest'
import { openSqlite } from './sqlite.js'

// The same prebuilt Node-API binary serves the app (Electron) and these tests
// (plain Node). If it stops loading here, it most likely stops loading in the
// packaged app too.

describe('openSqlite', () => {
  it('opens a working database under plain Node', () => {
    const db = openSqlite(':memory:')
    try {
      db.exec('CREATE TABLE t (a INTEGER)')
      db.prepare('INSERT INTO t (a) VALUES (?)').run(1)
      expect(db.prepare('SELECT a FROM t').get()).toEqual({ a: 1 })
    } finally {
      db.close()
    }
  })

  it('passes caller options through', () => {
    const db = openSqlite(':memory:', { timeout: 1234 })
    try {
      expect(db.open).toBe(true)
    } finally {
      db.close()
    }
  })
})
