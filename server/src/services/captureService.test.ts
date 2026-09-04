import { describe, it, expect, beforeEach } from 'vitest'
import {
  canCapture,
  configureCapture,
  listSources,
  resolvePendingSource,
  setPendingSource,
  takePendingSource,
  type CapturerSource,
  type DesktopCapturerLike,
} from './captureService.js'

// The seam exists so this can be tested without Electron, the same way
// systemService takes a ShellLike. What matters here is the refusal behaviour:
// a capture that cannot prove the coach chose it must not fall back to
// recording the whole screen.

function fakeSource(id: string, name: string, empty = false): CapturerSource {
  return {
    id,
    name,
    thumbnail: {
      toDataURL: () => `data:image/png;base64,${id}`,
      isEmpty: () => empty,
    },
  }
}

function fakeCapturer(sources: CapturerSource[]): DesktopCapturerLike {
  return { getSources: async () => sources }
}

const SOURCES = [
  fakeSource('screen:0:0', 'Entire screen'),
  fakeSource('window:12:0', 'CoachBoard'),
  fakeSource('window:34:0', 'Minimised thing', true),
]

beforeEach(() => {
  configureCapture({ desktopCapturer: fakeCapturer(SOURCES) })
  setPendingSource(null)
})

describe('canCapture', () => {
  it('is false outside Electron so the UI can explain instead of offering a dead button', () => {
    configureCapture({ desktopCapturer: null })
    expect(canCapture()).toBe(false)
    expect(listSources()).resolves.toEqual([])
  })

  it('is true once the main process injects the capturer', () => {
    expect(canCapture()).toBe(true)
  })
})

describe('listSources', () => {
  it('classifies screens and windows by Electron s id prefix', async () => {
    const list = await listSources()
    expect(list.map((s) => s.kind)).toEqual(['screen', 'window', 'window'])
  })

  it('returns null rather than a broken image for a minimised window', async () => {
    const list = await listSources()
    expect(list[0].thumbnailDataUrl).toContain('data:image/png')
    expect(list[2].thumbnailDataUrl).toBeNull()
  })
})

describe('pending source', () => {
  it('is consumed on read, so an abandoned choice cannot decide a later capture', () => {
    setPendingSource('window:12:0')
    expect(takePendingSource()).toBe('window:12:0')
    expect(takePendingSource()).toBeNull()
  })

  it('resolves a parked id to the live source', async () => {
    setPendingSource('window:12:0')
    const resolved = await resolvePendingSource()
    expect(resolved?.name).toBe('CoachBoard')
  })

  it('resolves to null when nothing was chosen — the handler must refuse, not guess', async () => {
    expect(await resolvePendingSource()).toBeNull()
  })

  it('resolves to null when the chosen window has since closed', async () => {
    setPendingSource('window:99:0')
    expect(await resolvePendingSource()).toBeNull()
  })

  it('does not leave the id behind after a failed resolve', async () => {
    setPendingSource('window:99:0')
    await resolvePendingSource()
    expect(takePendingSource()).toBeNull()
  })
})
