import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createApp } from '../app.js'
import { initializeDatabase, getDb } from '../db.js'
import { configureSecureStore } from './secureStore.js'
import { mirrorCopyDone, newestBackupPath, runStartupBackup, startDailyBackups } from './backupService.js'
import {
  MirrorError,
  clearMirrorDir,
  configureBackupMirror,
  mirrorStatus,
  setMirrorDir,
} from './backupMirrorService.js'

// N4 (D91–D94): the second backup folder.

vi.spyOn(console, 'log').mockImplementation(() => {})

let root = ''
let dataDir = ''
let mirror = ''
let server: Server
let baseUrl = ''

const backupsIn = (dir: string) => fs.readdirSync(dir).filter((f) => /^coachboard-.*Z\.sqlite$/.test(f)).sort()
const backUp = async () => { await runStartupBackup(); return mirrorCopyDone() }
// Backup names are timestamps to the millisecond; keep two from sharing one.
const tick = () => new Promise((r) => setTimeout(r, 5))

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coachboard-mirror-'))
  dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir)
  configureSecureStore({ userDataDir: dataDir })
  await initializeDatabase(path.join(dataDir, 'coachboard.sqlite'))
  const app = createApp()
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  configureBackupMirror({ pickFolder: null })
  try { await getDb().destroy() } catch { /* closed */ }
  configureSecureStore({ userDataDir: null })
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* Windows lock */ }
})

beforeEach(() => {
  clearMirrorDir()
  mirror = fs.mkdtempSync(path.join(root, 'onedrive-'))
})

describe('second backup folder', () => {
  it('is off until a folder is chosen: backups stay local only', async () => {
    expect(mirrorStatus().dir).toBeNull()
    expect(await backUp()).toBe(false)
    expect(backupsIn(mirror)).toEqual([])
  })

  it('refuses a folder that is missing, relative, or CoachBoard’s own', async () => {
    await expect(setMirrorDir(path.join(root, 'nope'), null)).rejects.toThrow(/can't be found/)
    await expect(setMirrorDir('relative/folder', null)).rejects.toBeInstanceOf(MirrorError)
    await expect(setMirrorDir(path.join(dataDir, 'backups'), null)).rejects.toThrow(/outside CoachBoard's own data folder/)
    await expect(setMirrorDir(root, null)).rejects.toThrow(/outside/) // holds the data folder
    expect(mirrorStatus().dir).toBeNull()
  })

  it('copies the newest backup at once when the folder is chosen', async () => {
    await runStartupBackup()
    const newest = newestBackupPath()!
    const status = await setMirrorDir(mirror, newest)
    expect(status.dir).toBe(path.resolve(mirror))
    expect(status.lastCopiedFile).toBe(path.basename(newest))
    expect(status.error).toBeNull()
    expect(backupsIn(mirror)).toEqual([path.basename(newest)])
    // The copy is the same file, byte for byte, and no half-written file is left.
    expect(fs.readFileSync(path.join(mirror, path.basename(newest)))).toEqual(fs.readFileSync(newest))
    expect(fs.readdirSync(mirror).some((f) => f.endsWith('.partial'))).toBe(false)
  })

  it('copies every backup and keeps the 5 newest there, leaving the coach’s own files alone', async () => {
    await setMirrorDir(mirror, null)
    fs.writeFileSync(path.join(mirror, 'coachboard-my-own-copy.sqlite'), 'mine')
    fs.writeFileSync(path.join(mirror, 'notes.txt'), 'mine')
    for (let i = 0; i < 7; i++) { expect(await backUp()).toBe(true); await tick() }
    const kept = backupsIn(mirror)
    expect(kept).toHaveLength(5)
    // The newest five: the same as the local folder's newest.
    expect(kept[kept.length - 1]).toBe(path.basename(newestBackupPath()!))
    expect(fs.existsSync(path.join(mirror, 'coachboard-my-own-copy.sqlite'))).toBe(true)
    expect(fs.existsSync(path.join(mirror, 'notes.txt'))).toBe(true)
  })

  it('a folder that went away: the local backup is still made, and it says why and since when', async () => {
    await setMirrorDir(mirror, null)
    fs.rmSync(mirror, { recursive: true, force: true }) // the USB drive was pulled
    const before = newestBackupPath()
    await tick()
    expect(await backUp()).toBe(false)
    expect(newestBackupPath()).not.toBe(before) // the local one happened
    const first = mirrorStatus()
    expect(first.error).toMatch(/can't be found/)
    expect(first.failingSince).not.toBeNull()
    // Failing again keeps the first time it started, so the message shows once.
    await tick()
    await backUp()
    expect(mirrorStatus().failingSince).toBe(first.failingSince)
    // Plugged back in: the next copy works and the error goes.
    fs.mkdirSync(mirror)
    await tick()
    expect(await backUp()).toBe(true)
    expect(mirrorStatus()).toMatchObject({ error: null, failingSince: null })
  })

  it('stopping leaves the copies already there', async () => {
    await setMirrorDir(mirror, null)
    await backUp()
    const there = backupsIn(mirror)
    expect(clearMirrorDir().dir).toBeNull()
    await tick()
    await backUp()
    expect(backupsIn(mirror)).toEqual(there)
  })

  it('is kept beside the database, not in it — a restored backup carries no folder', () => {
    expect(fs.existsSync(path.join(dataDir, 'backup-mirror.json'))).toBe(true)
  })
})

describe('a backup a day while the app stays open', () => {
  it('takes one when the newest is older than a day, and not otherwise', async () => {
    await runStartupBackup()
    const newest = newestBackupPath()!
    const stopFresh = startDailyBackups({ checkEveryMs: 10, maxAgeMs: 60_000 })
    await new Promise((r) => setTimeout(r, 60))
    stopFresh()
    expect(newestBackupPath()).toBe(newest)

    const old = (Date.now() - 2 * 86_400_000) / 1000
    fs.utimesSync(newest, old, old)
    const stopOld = startDailyBackups({ checkEveryMs: 10, maxAgeMs: 86_400_000 })
    await vi.waitFor(() => expect(newestBackupPath()).not.toBe(newest), { timeout: 2000 })
    stopOld()
  })
})

describe('routes', () => {
  const call = async (method: string, p: string) => {
    const res = await fetch(`${baseUrl}${p}`, { method })
    return { status: res.status, body: await res.json() }
  }

  it('choosing needs the app’s folder dialog', async () => {
    configureBackupMirror({ pickFolder: null })
    const { status, body } = await call('POST', '/api/backup/mirror/pick')
    expect(status).toBe(400)
    expect(body.error).toMatch(/only works in the CoachBoard app/)
    expect((await call('GET', '/api/backup/mirror')).body.canPick).toBe(false)
  })

  it('cancelling the dialog changes nothing; picking a folder starts copying', async () => {
    configureBackupMirror({ pickFolder: async () => null })
    expect((await call('POST', '/api/backup/mirror/pick')).body).toMatchObject({ cancelled: true, status: { dir: null } })

    configureBackupMirror({ pickFolder: async () => mirror })
    const picked = await call('POST', '/api/backup/mirror/pick')
    expect(picked.status).toBe(200)
    expect(picked.body.status.dir).toBe(path.resolve(mirror))
    expect(backupsIn(mirror)).toHaveLength(1)

    // Back up now waits for the second folder and says how it went.
    const now = await call('POST', '/api/backup/now')
    expect(now.body.mirror.lastCopiedFile).toBe(path.basename(now.body.path))

    expect((await call('DELETE', '/api/backup/mirror')).body.dir).toBeNull()
  })

  it('a folder that is refused says why', async () => {
    configureBackupMirror({ pickFolder: async () => dataDir })
    const { status, body } = await call('POST', '/api/backup/mirror/pick')
    expect(status).toBe(400)
    expect(body.error).toMatch(/outside CoachBoard's own data folder/)
  })
})
