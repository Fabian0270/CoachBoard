import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createApp } from '../app.js'
import { initializeDatabase, getDb } from '../db.js'
import { configureSecureStore } from '../services/secureStore.js'
import { configureSystem } from '../services/systemService.js'
import { configureUpdates, resetUpdateStateForTests, setUpdateState } from '../services/updateService.js'

vi.spyOn(console, 'log').mockImplementation(() => {})

let server: Server
let baseUrl = ''
let dir = ''

const revealed: string[] = []

const json = async (p: string, init?: RequestInit) => {
  const res = await fetch(`${baseUrl}${p}`, init)
  // 202 and 204 both answer with no body, so parse only when there is one.
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coachboard-routes-'))
  configureSecureStore({ userDataDir: dir })
  await initializeDatabase(path.join(dir, 'coachboard.sqlite'))

  const app = createApp()
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
  try {
    await getDb().destroy()
  } catch { /* already closed */ }
  configureSecureStore({ userDataDir: null })
  configureSystem({ shell: null })
  resetUpdateStateForTests()
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* Windows may still hold the file */ }
})

describe('GET /api/system/paths', () => {
  it('reports where the coach\'s data lives', async () => {
    const { status, body } = await json('/api/system/paths')
    expect(status).toBe(200)
    expect(body.dataDir).toBe(dir)
    expect(body.databasePath).toBe(path.join(dir, 'coachboard.sqlite'))
    expect(body.logPath).toBe(path.join(dir, 'coachboard.log'))
  })

  it('says revealing is unavailable when not running under Electron', async () => {
    configureSystem({ shell: null })
    const { body } = await json('/api/system/paths')
    expect(body.canReveal).toBe(false)
  })
})

describe('POST /api/system/reveal', () => {
  it('rejects an unknown target instead of opening anything', async () => {
    const { status } = await json('/api/system/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'C:\\Windows\\System32' }),
    })
    expect(status).toBe(400)
    expect(revealed).toEqual([])
  })

  it('returns 503 rather than failing when there is no shell', async () => {
    const { status } = await json('/api/system/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'data' }),
    })
    expect(status).toBe(503)
  })

  it('opens the data folder once a shell is injected', async () => {
    configureSystem({
      shell: {
        async openPath(target: string) { revealed.push(target); return '' },
        showItemInFolder(target: string) { revealed.push(target) },
      },
    })
    const { status } = await json('/api/system/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'data' }),
    })
    expect(status).toBe(204)
    expect(revealed).toEqual([dir])
  })
})

describe('update endpoints', () => {
  it('always answers with a status, even before any check has run', async () => {
    resetUpdateStateForTests()
    const { status, body } = await json('/api/system/update')
    expect(status).toBe(200)
    expect(body).toEqual({ status: 'idle', version: null, message: null })
  })

  it('refuses to install when no update is ready', async () => {
    resetUpdateStateForTests()
    const { status } = await json('/api/system/update/install', { method: 'POST' })
    expect(status).toBe(409)
  })

  it('installs once an update has downloaded', async () => {
    let installed = false
    configureUpdates({ install: () => { installed = true } })
    setUpdateState({ status: 'ready', version: '1.14.1' })

    const { status } = await json('/api/system/update/install', { method: 'POST' })
    expect(status).toBe(202)
    expect(installed).toBe(true)
  })
})

describe('GET /api/backup/info', () => {
  it('reports the database location and backup state', async () => {
    const { status, body } = await json('/api/backup/info')
    expect(status).toBe(200)
    expect(body.databasePath).toBe(path.join(dir, 'coachboard.sqlite'))
    expect(body.restorePending).toBe(false)
  })
})

describe('POST /api/backup/restore', () => {
  it('rejects a file that is not a database, with a reason the coach can act on', async () => {
    const res = await fetch(`${baseUrl}/api/backup/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('this is a spreadsheet, not a database'),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not a SQLite database/i)
  })

  it('rejects an empty upload', async () => {
    const res = await fetch(`${baseUrl}/api/backup/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(0),
    })
    expect(res.status).toBe(400)
  })
})
