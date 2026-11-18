import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import JSZip from 'jszip'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { initializeDatabase, getDb } from '../db.js'
import { configureSecureStore } from './secureStore.js'
import { configureSystem } from './systemService.js'
import { buildReport, logTail, reportPreview, sendReport, LOG_TAIL_BYTES, SUPPORT_ADDRESS } from './problemReportService.js'
import { createApp } from '../app.js'

// S4 (D81–D83): what a problem report holds, and where it goes.

let tmpDir: string
beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-report-'))
  configureSecureStore({ safeStorage: null, userDataDir: tmpDir })
  configureSystem({ appVersion: '1.18.0' })
  await initializeDatabase(path.join(tmpDir, 'coachboard.sqlite'))
})
afterEach(async () => {
  configureSystem({ appVersion: null })
  await getDb().destroy()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

const unzip = async (buf: Buffer) => JSZip.loadAsync(buf)

describe('the log tail', () => {
  it('is the end of the log, reaching into the rolled-over one when needed', () => {
    fs.writeFileSync(path.join(tmpDir, 'coachboard.log.1'), 'old line\n')
    fs.writeFileSync(path.join(tmpDir, 'coachboard.log'), 'new line\n')
    expect(logTail().toString()).toBe('old line\nnew line\n')
  })

  it('stops at 2 MB, keeping the newest', () => {
    fs.writeFileSync(path.join(tmpDir, 'coachboard.log.1'), 'x'.repeat(1000))
    fs.writeFileSync(path.join(tmpDir, 'coachboard.log'), 'a'.repeat(LOG_TAIL_BYTES - 10) + 'END')
    const tail = logTail()
    expect(tail.length).toBe(LOG_TAIL_BYTES)
    expect(tail.toString().endsWith('END')).toBe(true)
    expect(tail.toString().startsWith('xxxxxxx')).toBe(true)
  })

  it('is empty without a log', () => {
    expect(logTail().length).toBe(0)
  })
})

describe('buildReport', () => {
  it('holds the description, version, system, log and the ticked file — and no database', async () => {
    fs.writeFileSync(path.join(tmpDir, 'coachboard.log'), 'Import failed: no Sets header\n')
    const { zip, name } = await buildReport({
      description: 'The import says no Sets column',
      file: { name: 'Block 3.xlsx', content: Buffer.from('fake xlsx') },
    }, new Date('2026-11-18T19:05:00Z'))
    expect(name).toBe('coachboard-report-2026-11-18-19-05.zip')
    const z = await unzip(zip)
    expect(Object.keys(z.files).sort()).toEqual(['coachboard.log', 'file/', 'file/Block 3.xlsx', 'report.txt'])
    const report = await z.file('report.txt')!.async('string')
    expect(report).toContain('Version: 1.18.0')
    expect(report).toContain('The import says no Sets column')
    expect(report).toContain('Attached file: Block 3.xlsx (9 bytes)')
    expect(await z.file('coachboard.log')!.async('string')).toContain('no Sets header')
    expect(Object.keys(z.files).some((f) => f.endsWith('.sqlite'))).toBe(false)
  })

  it('without a ticked file, none goes in', async () => {
    const z = await unzip((await buildReport({ description: 'x' })).zip)
    expect(Object.keys(z.files).sort()).toEqual(['coachboard.log', 'report.txt'])
  })
})

describe('sending', () => {
  it('without email set up, says so (the app then saves the .zip)', async () => {
    const preview = await reportPreview()
    expect(preview).toMatchObject({ version: '1.18.0', emailConfigured: false, supportAddress: SUPPORT_ADDRESS })
    expect(await sendReport({ description: 'x' })).toMatchObject({ ok: false, code: 'not_configured' })
  })

  it('the zip route hands back a .zip', async () => {
    const server: Server = createApp().listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/support/report`
      const file = Buffer.alloc(200_000, 7).toString('base64') // past the default 100 kb body limit
      const res = await fetch(`${base}/zip`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: 'Big sheet', file: { name: 'big.xlsx', base64: file } }),
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/zip')
      expect(res.headers.get('content-disposition')).toMatch(/coachboard-report-.*\.zip/)
      const z = await unzip(Buffer.from(await res.arrayBuffer()))
      expect((await z.file('file/big.xlsx')!.async('nodebuffer')).length).toBe(200_000)
      const send = await fetch(`${base}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'x' }) })
      expect(send.status).toBe(400)
      expect((await send.json()).code).toBe('not_configured')
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})
