import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { configureLogger, log, logError } from './logger.js'

// The logger tees to stdout by design; silence it so the suite stays readable.
vi.spyOn(console, 'log').mockImplementation(() => {})

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coachboard-log-'))
let logPath = ''

beforeEach(() => {
  logPath = path.join(tmp, `${Math.random().toString(36).slice(2)}.log`)
  configureLogger(logPath)
})

afterAll(() => {
  // Leave the module unconfigured so other suites in this worker don't inherit a path.
  configureLogger(undefined)
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('logger', () => {
  it('writes timestamped lines to the configured file', () => {
    log('hello')
    const written = fs.readFileSync(logPath, 'utf8')
    expect(written).toContain('hello')
    expect(written).toMatch(/^\[\d{4}-\d{2}-\d{2}T/)
  })

  it('records the stack of an Error, not just its message', () => {
    logError('Failed to fetch athletes', new Error('SQLITE_CONSTRAINT: UNIQUE failed'))
    const written = fs.readFileSync(logPath, 'utf8')
    expect(written).toContain('ERROR Failed to fetch athletes')
    expect(written).toContain('SQLITE_CONSTRAINT: UNIQUE failed')
    // The stack is the whole point — it is what was being thrown away before.
    expect(written).toContain('logger.test')
  })

  it('handles a non-Error throw without losing it', () => {
    logError('Failed to do thing', 'a bare string')
    expect(fs.readFileSync(logPath, 'utf8')).toContain('a bare string')
  })

  it('never throws when the log path is unwritable', () => {
    configureLogger(path.join(tmp, 'no', 'such', 'dir', 'x.log'))
    expect(() => log('should not throw')).not.toThrow()
  })

  it('rotates the log once it passes the size cap, keeping one generation', () => {
    // Seed the file just over the 5 MB cap.
    fs.writeFileSync(logPath, 'x'.repeat(5 * 1024 * 1024 + 1))
    log('after rotation')

    expect(fs.existsSync(`${logPath}.1`)).toBe(true)
    const current = fs.readFileSync(logPath, 'utf8')
    expect(current).toContain('after rotation')
    // The rolled generation is the old content, so the live file starts fresh.
    expect(current.length).toBeLessThan(1000)
  })
})
