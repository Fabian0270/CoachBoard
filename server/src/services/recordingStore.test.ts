import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { configureSecureStore } from './secureStore.js'
import {
  appendChunk,
  beginRecording,
  deleteRecording,
  finishRecording,
  recordingPath,
  statRecording,
  sweepRecordings,
} from './recordingStore.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-rec-'))
  configureSecureStore({ safeStorage: null, userDataDir: tmpDir })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** A minimal chunk that starts with the EBML magic MediaRecorder emits. */
const header = (extra = 'body') => Buffer.concat([
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
  Buffer.from(extra),
])

describe('the ordinary path', () => {
  it('accumulates chunks and seals the file', async () => {
    const id = await beginRecording()
    expect(await appendChunk(id, header('one'))).toBe(7)
    expect(await appendChunk(id, Buffer.from('two'))).toBe(10)

    const info = await finishRecording(id)
    expect(info).toEqual({ id, bytes: 10, complete: true })

    const abs = await recordingPath(id)
    expect(abs).not.toBeNull()
    expect(fs.readFileSync(abs!).toString()).toContain('one')
    expect(fs.readFileSync(abs!).toString()).toContain('two')
  })

  it('reports progress while still recording', async () => {
    const id = await beginRecording()
    await appendChunk(id, header())
    expect(await statRecording(id)).toEqual({ id, bytes: 8, complete: false })
    // Not servable until sealed — a half-written file must never reach a player.
    expect(await recordingPath(id)).toBeNull()
  })
})

describe('refusals', () => {
  it('rejects a first chunk that is not WebM', async () => {
    const id = await beginRecording()
    await expect(appendChunk(id, Buffer.from('not a video'))).rejects.toThrow('WebM')
  })

  it('only checks the first chunk, since continuations carry no magic', async () => {
    const id = await beginRecording()
    await appendChunk(id, header())
    await expect(appendChunk(id, Buffer.from('raw continuation'))).resolves.toBeGreaterThan(0)
  })

  it('rejects an append to an id that was never started', async () => {
    await expect(
      appendChunk('11111111-1111-1111-1111-111111111111', header()),
    ).rejects.toThrow('No such recording')
  })

  it('rejects an id that is not one of ours, so the path cannot be steered', async () => {
    await expect(appendChunk('../../etc/passwd', header())).rejects.toThrow('Invalid recording id')
  })

  it('refuses to seal a recording that captured nothing', async () => {
    const id = await beginRecording()
    await expect(finishRecording(id)).rejects.toThrow('empty')
    // And leaves no file behind that would look real and play as nothing.
    expect(await statRecording(id)).toBeNull()
  })
})

describe('discarding', () => {
  it('removes a finished recording', async () => {
    const id = await beginRecording()
    await appendChunk(id, header())
    await finishRecording(id)
    await deleteRecording(id)
    expect(await statRecording(id)).toBeNull()
  })

  it('removes a recording abandoned mid-capture', async () => {
    const id = await beginRecording()
    await appendChunk(id, header())
    await deleteRecording(id)
    expect(await statRecording(id)).toBeNull()
  })
})

describe('sweepRecordings', () => {
  it('empties the folder, because anything surviving a restart was abandoned', async () => {
    const finished = await beginRecording()
    await appendChunk(finished, header())
    await finishRecording(finished)
    const partial = await beginRecording()
    await appendChunk(partial, header())

    expect(await sweepRecordings()).toBe(2)
    expect(await statRecording(finished)).toBeNull()
    expect(await statRecording(partial)).toBeNull()
  })

  it('is a no-op when nothing has ever been recorded', async () => {
    expect(await sweepRecordings()).toBe(0)
  })
})
