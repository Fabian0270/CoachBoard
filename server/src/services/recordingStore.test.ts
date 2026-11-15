import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { configureSecureStore } from './secureStore.js'
import {
  appendChunk,
  beginTrack,
  discardEdit,
  trackPath,
  writeAt,
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
    expect(info).toEqual({ id, bytes: 10, complete: true, hasCamera: false, edited: false })

    const abs = await recordingPath(id)
    expect(abs).not.toBeNull()
    expect(fs.readFileSync(abs!).toString()).toContain('one')
    expect(fs.readFileSync(abs!).toString()).toContain('two')
  })

  it('reports progress while still recording', async () => {
    const id = await beginRecording()
    await appendChunk(id, header())
    expect(await statRecording(id)).toEqual({ id, bytes: 8, complete: false, hasCamera: false, edited: false })
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

describe('tracks: webcam and edited result', () => {
  const recorded = async () => {
    const id = await beginRecording()
    await appendChunk(id, header('screen'))
    await finishRecording(id)
    return id
  }

  it('keeps the webcam as its own file next to the screen recording', async () => {
    const id = await beginRecording()
    await appendChunk(id, header('screen'))
    await beginTrack(id, 'camera')
    await appendChunk(id, header('cam'), 'camera')
    await finishRecording(id, 'camera')
    const info = await finishRecording(id)
    expect(info).toMatchObject({ complete: true, hasCamera: true, edited: false })
    expect(fs.readFileSync((await trackPath(id, 'camera'))!).toString()).toContain('cam')
    // Saving and sending still get the screen recording until something is edited.
    expect(fs.readFileSync((await recordingPath(id))!).toString()).toContain('screen')
  })

  it('treats an empty webcam track as no webcam rather than an error', async () => {
    const id = await beginRecording()
    await appendChunk(id, header('screen'))
    await beginTrack(id, 'camera')
    await expect(finishRecording(id, 'camera')).resolves.toMatchObject({ hasCamera: false })
  })

  it('saves and sends the edited result once there is one, and its size', async () => {
    const id = await recorded()
    await beginTrack(id, 'final')
    await appendChunk(id, header('edited-longer'), 'final')
    const info = await finishRecording(id, 'final')
    expect(info).toMatchObject({ edited: true, bytes: 4 + 'edited-longer'.length })
    expect(fs.readFileSync((await recordingPath(id))!).toString()).toContain('edited-longer')
    // The editor still reads the original.
    expect(fs.readFileSync((await trackPath(id, 'screen'))!).toString()).toContain('screen')
  })

  it('replaces the previous edit when exporting again, and can drop it', async () => {
    const id = await recorded()
    await beginTrack(id, 'final')
    await appendChunk(id, header('first'), 'final')
    await finishRecording(id, 'final')
    await beginTrack(id, 'final')
    // While the new export is written, nothing half-done is served.
    expect(fs.readFileSync((await recordingPath(id))!).toString()).toContain('screen')
    await appendChunk(id, header('second'), 'final')
    await finishRecording(id, 'final')
    expect(fs.readFileSync((await recordingPath(id))!).toString()).toContain('second')

    await discardEdit(id)
    expect(fs.readFileSync((await recordingPath(id))!).toString()).toContain('screen')
    expect(await statRecording(id)).toMatchObject({ edited: false })
  })

  it('refuses a track for a recording that does not exist', async () => {
    await expect(beginTrack('00000000-0000-0000-0000-000000000000', 'camera')).rejects.toThrow('No such recording')
  })

  it('deletes and sweeps every track', async () => {
    const id = await recorded()
    await beginTrack(id, 'camera')
    await appendChunk(id, header('cam'), 'camera')
    await finishRecording(id, 'camera')
    await beginTrack(id, 'final')
    await appendChunk(id, header('final'), 'final')
    await finishRecording(id, 'final')
    await deleteRecording(id)
    expect(await statRecording(id)).toBeNull()
    expect(await trackPath(id, 'camera')).toBeNull()
    expect(await trackPath(id, 'final')).toBeNull()
  })
})

describe('the edited result is written at positions', () => {
  it('lets the writer go back and fill in earlier bytes', async () => {
    const id = await beginRecording()
    await appendChunk(id, header('screen'))
    await finishRecording(id)
    await beginTrack(id, 'final')
    await writeAt(id, 0, header('AAAA'))
    await writeAt(id, 8, Buffer.from('tail'))
    await writeAt(id, 4, Buffer.from('BB')) // back-fill, like a size field
    await finishRecording(id, 'final')
    const bytes = fs.readFileSync((await recordingPath(id))!)
    expect(bytes.subarray(4).toString()).toBe('BBAAtail')
  })

  it('refuses a bad offset, a non-WebM start, or a track that was not begun', async () => {
    const id = await beginRecording()
    await appendChunk(id, header())
    await finishRecording(id)
    await expect(writeAt(id, 0, header())).rejects.toThrow('No such recording')
    await beginTrack(id, 'final')
    await expect(writeAt(id, -1, header())).rejects.toThrow('Invalid position')
    await expect(writeAt(id, 0, Buffer.from('nope'))).rejects.toThrow('WebM')
  })
})
