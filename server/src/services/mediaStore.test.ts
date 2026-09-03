import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import { configureSecureStore } from './secureStore.js'
import {
  sanitizeFilename,
  discordMediaRelPath,
  resolveMediaAbsPath,
  downloadToFile,
  thumbRelPath,
  writeMediaFile,
  deleteAllFilesFor,
  MediaTooLargeError,
  MediaDownloadError,
} from './mediaStore.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-media-'))
  configureSecureStore({ safeStorage: null, userDataDir: tmpDir })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('sanitizeFilename', () => {
  it('strips path separators and illegal characters', () => {
    expect(sanitizeFilename('..\\..\\evil.mp4')).not.toContain('\\')
    expect(sanitizeFilename('a/b:c*d?.mp4')).toBe('a_b_c_d_.mp4')
  })

  it('collapses dot runs so traversal cannot survive', () => {
    expect(sanitizeFilename('....//....//x.mp4')).not.toContain('..')
  })

  it('guards Windows reserved device names', () => {
    expect(sanitizeFilename('CON.mp4')).toBe('_CON.mp4')
    expect(sanitizeFilename('nul.mov')).toBe('_nul.mov')
  })

  it('keeps the extension when capping very long names', () => {
    const out = sanitizeFilename(`${'x'.repeat(300)}.mp4`)
    expect(out.length).toBeLessThanOrEqual(104)
    expect(out.endsWith('.mp4')).toBe(true)
  })

  it('handles emoji and empty names', () => {
    expect(sanitizeFilename('💪🏋️.mp4').endsWith('.mp4')).toBe(true)
    expect(sanitizeFilename('')).toBe('attachment')
  })
})

describe('discordMediaRelPath', () => {
  it('builds a stable month-bucketed path with message + attachment ids', () => {
    const rel = discordMediaRelPath('2026-07-03T10:00:00.000Z', 'msg1', 'att1', 'video.mov')
    expect(rel).toBe('media/discord/2026-07/msg1_att1_video.mov')
  })
})

describe('thumbRelPath', () => {
  it('buckets by month and keys by media id', () => {
    expect(thumbRelPath('2026-07-03T10:00:00.000Z', 'abc-123')).toBe(
      'media/thumbs/2026-07/abc-123.jpg',
    )
  })

  it('falls back to a bucket rather than producing a rootless path', () => {
    expect(thumbRelPath('', 'abc')).toBe('media/thumbs/unknown/abc.jpg')
  })
})

describe('writeMediaFile', () => {
  it('creates missing directories and leaves no .part behind', async () => {
    await writeMediaFile('media/thumbs/2026-07/x.jpg', Buffer.from('jpegbytes'))
    const abs = path.join(tmpDir, 'media', 'thumbs', '2026-07', 'x.jpg')
    expect(fs.readFileSync(abs, 'utf8')).toBe('jpegbytes')
    expect(fs.existsSync(`${abs}.part`)).toBe(false)
  })

  it('refuses to write outside the media root', async () => {
    await expect(writeMediaFile('../escape.jpg', Buffer.from('x'))).rejects.toThrow()
  })
})

describe('deleteAllFilesFor', () => {
  // Regression guard: the thumbnail column was added after three delete paths
  // already existed, and each one that forgets a derived file leaks it forever.
  it('removes the source and every derived file', async () => {
    await writeMediaFile('media/discord/2026-07/v.mp4', Buffer.from('video'))
    await writeMediaFile('media/thumbs/2026-07/v.jpg', Buffer.from('thumb'))
    await writeMediaFile('media/converted/2026-07/v.webm', Buffer.from('converted'))

    const deleted = await deleteAllFilesFor({
      local_path: 'media/discord/2026-07/v.mp4',
      thumb_path: 'media/thumbs/2026-07/v.jpg',
      transcoded_path: 'media/converted/2026-07/v.webm',
    })

    expect(deleted).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'media', 'discord', '2026-07', 'v.mp4'))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, 'media', 'thumbs', '2026-07', 'v.jpg'))).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, 'media', 'converted', '2026-07', 'v.webm'))).toBe(false)
  })

  it('reports only whether the SOURCE went, so delete counts stay honest', async () => {
    await writeMediaFile('media/thumbs/2026-07/orphan.jpg', Buffer.from('thumb'))
    const deleted = await deleteAllFilesFor({
      local_path: null,
      thumb_path: 'media/thumbs/2026-07/orphan.jpg',
      transcoded_path: null,
    })
    expect(deleted).toBe(false)
    expect(fs.existsSync(path.join(tmpDir, 'media', 'thumbs', '2026-07', 'orphan.jpg'))).toBe(false)
  })

  it('tolerates already-missing files', async () => {
    await expect(
      deleteAllFilesFor({
        local_path: 'media/discord/2026-07/gone.mp4',
        thumb_path: 'media/thumbs/2026-07/gone.jpg',
        transcoded_path: null,
      }),
    ).resolves.toBe(false)
  })
})

describe('resolveMediaAbsPath', () => {
  it('resolves inside the media root', () => {
    const abs = resolveMediaAbsPath('media/discord/2026-07/a.mp4')
    expect(abs.startsWith(path.join(tmpDir, 'media'))).toBe(true)
  })

  it('rejects traversal escapes', () => {
    expect(() => resolveMediaAbsPath('media/../../outside.txt')).toThrow()
    expect(() => resolveMediaAbsPath('../outside.txt')).toThrow()
  })
})

describe('downloadToFile', () => {
  const withServer = async (
    handler: http.RequestListener,
    fn: (url: string) => Promise<void>,
  ) => {
    const server = http.createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    try {
      await fn(`http://127.0.0.1:${port}/file`)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  it('streams to .part, renames, and returns the correct sha256', async () => {
    const payload = Buffer.from('form-check-video-bytes'.repeat(1000))
    const expected = crypto.createHash('sha256').update(payload).digest('hex')
    await withServer(
      (_req, res) => {
        res.writeHead(200)
        res.end(payload)
      },
      async (url) => {
        const absPath = path.join(tmpDir, 'media', 'discord', 'out.mp4')
        const result = await downloadToFile(url, absPath, { maxBytes: 10_000_000 })
        expect(result.sha256).toBe(expected)
        expect(result.bytes).toBe(payload.length)
        expect(fs.existsSync(absPath)).toBe(true)
        expect(fs.existsSync(`${absPath}.part`)).toBe(false)
      },
    )
  })

  it('aborts over the size cap and removes the .part file', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200)
        res.end(Buffer.alloc(50_000))
      },
      async (url) => {
        const absPath = path.join(tmpDir, 'media', 'discord', 'big.mp4')
        await expect(downloadToFile(url, absPath, { maxBytes: 10_000 })).rejects.toBeInstanceOf(
          MediaTooLargeError,
        )
        expect(fs.existsSync(absPath)).toBe(false)
        expect(fs.existsSync(`${absPath}.part`)).toBe(false)
      },
    )
  })

  it('throws MediaDownloadError with the HTTP status on 4xx', async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(404)
        res.end()
      },
      async (url) => {
        const absPath = path.join(tmpDir, 'media', 'discord', 'gone.mp4')
        const err = await downloadToFile(url, absPath, { maxBytes: 10_000 }).catch((e) => e)
        expect(err).toBeInstanceOf(MediaDownloadError)
        expect((err as MediaDownloadError).status).toBe(404)
      },
    )
  })
})
