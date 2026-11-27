import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initializeDatabase, getDb } from '../db.js'
import { configureSecureStore } from './secureStore.js'
import { getPreferences, setPreferences } from './preferencesService.js'

// The day editor's suggested loads: on until the coach switches them off.

let tmpDir: string
beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-prefs-'))
  configureSecureStore({ safeStorage: null, userDataDir: tmpDir })
  await initializeDatabase(path.join(tmpDir, 'test.sqlite'))
})
afterEach(async () => {
  await getDb().destroy()
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

describe('preferences', () => {
  it('suggested loads are on by default, and stay as set', async () => {
    expect(await getPreferences()).toEqual({ loadHints: true })
    expect(await setPreferences({ loadHints: false })).toEqual({ loadHints: false })
    expect(await getPreferences()).toEqual({ loadHints: false })
    expect(await setPreferences({})).toEqual({ loadHints: false })
    expect(await setPreferences({ loadHints: true })).toEqual({ loadHints: true })
  })
})
