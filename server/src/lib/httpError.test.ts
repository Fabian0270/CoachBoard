import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import type { Response } from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { configureLogger } from './logger.js'
import { fail } from './httpError.js'

vi.spyOn(console, 'log').mockImplementation(() => {})

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coachboard-httperr-'))
let logPath = ''

/** Minimal Express Response stand-in that records what a handler sent. */
function fakeRes() {
  const sent: { status?: number; body?: unknown } = {}
  const res = {
    status(code: number) {
      sent.status = code
      return this
    },
    json(body: unknown) {
      sent.body = body
      return this
    },
  }
  return { res: res as unknown as Response, sent }
}

beforeEach(() => {
  logPath = path.join(tmp, `${Math.random().toString(36).slice(2)}.log`)
  configureLogger(logPath)
})

afterAll(() => {
  configureLogger(undefined)
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('fail', () => {
  it('sends the generic message and 500 by default', () => {
    const { res, sent } = fakeRes()
    fail(res, 'Failed to fetch athletes', new Error('boom'))

    expect(sent.status).toBe(500)
    expect(sent.body).toEqual({ error: 'Failed to fetch athletes' })
  })

  it('keeps the stack out of the response but puts it in the log', () => {
    const { res, sent } = fakeRes()
    const err = new Error('SQLITE_CONSTRAINT: FOREIGN KEY constraint failed')
    fail(res, 'Failed to create program', err)

    // Nothing internal crosses the wire — this is the regression that mattered:
    // the global handler used to return err.stack straight into a UI toast.
    const body = JSON.stringify(sent.body)
    expect(body).not.toContain('SQLITE_CONSTRAINT')
    expect(body).not.toContain('at ')

    // ...but it is recoverable afterwards from the log.
    const written = fs.readFileSync(logPath, 'utf8')
    expect(written).toContain('SQLITE_CONSTRAINT: FOREIGN KEY constraint failed')
    expect(written).toContain('httpError.test')
  })

  it('honours an explicit status code', () => {
    const { res, sent } = fakeRes()
    fail(res, 'Bad upstream', new Error('x'), 502)
    expect(sent.status).toBe(502)
  })
})
