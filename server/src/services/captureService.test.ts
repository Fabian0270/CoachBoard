import { describe, it, expect, beforeEach } from 'vitest'
import {
  SELF_SOURCE_ID,
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
      toJPEG: () => Buffer.from(`jpeg-${id}`),
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
  configureCapture({ desktopCapturer: fakeCapturer(SOURCES), ownSourceIds: () => [], windowTools: null })
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
  it('offers CoachBoard first, then screens, then other windows', async () => {
    const list = await listSources()
    expect(list.map((s) => s.kind)).toEqual(['self', 'screen', 'window', 'window'])
    expect(list[0].id).toBe(SELF_SOURCE_ID)
  })

  it('always offers CoachBoard, which Electron 33 never enumerated', async () => {
    // The regression this guards: our own window is absent from getSources, so
    // the one thing a coach most wants to record was unofferable.
    configureCapture({ desktopCapturer: fakeCapturer([fakeSource('screen:0:0', 'Screen')]) })
    const list = await listSources()
    expect(list.some((s) => s.id === SELF_SOURCE_ID)).toBe(true)
  })

  it("leaves the app's own window out, since it is already offered first", async () => {
    // Electron 45 started listing our own window; offering it as a second
    // "CoachBoard" next to the frame-captured one would only confuse.
    configureCapture({ desktopCapturer: fakeCapturer(SOURCES), ownSourceIds: () => ['window:12:0'] })
    const list = await listSources()
    expect(list.find((s) => s.id === 'window:12:0')).toBeUndefined()
    expect(list.filter((s) => s.name === 'CoachBoard')).toHaveLength(1)
    expect(list[0].id).toBe(SELF_SOURCE_ID)
  })

  it('classifies screens and windows by Electron s id prefix', async () => {
    const list = await listSources()
    expect(list.find((s) => s.id === 'screen:0:0')?.kind).toBe('screen')
    expect(list.find((s) => s.id === 'window:12:0')?.kind).toBe('window')
  })

  it('returns null rather than a broken image for a minimised window', async () => {
    const list = await listSources()
    expect(list.find((s) => s.id === 'window:34:0')?.thumbnailDataUrl).toBeNull()
  })

  it('encodes thumbnails as JPEG, so higher resolution does not bloat the payload', async () => {
    const list = await listSources()
    expect(list.find((s) => s.id === 'window:12:0')?.thumbnailDataUrl).toBe(
      `data:image/jpeg;base64,${Buffer.from('jpeg-window:12:0').toString('base64')}`,
    )
  })

  it('falls back to the PNG data URL when a bundle predates toJPEG', async () => {
    const legacy: CapturerSource = {
      id: 'window:7:0',
      name: 'Old',
      // A packaged app can run against a bundle built before the interface grew.
      thumbnail: { toDataURL: () => 'data:image/png;base64,old', isEmpty: () => false } as never,
    }
    configureCapture({ desktopCapturer: fakeCapturer([legacy]) })
    expect((await listSources())[1].thumbnailDataUrl).toBe('data:image/png;base64,old')
  })

  it('hides always-present overlay windows that are never worth recording', async () => {
    configureCapture({
      desktopCapturer: fakeCapturer([
        fakeSource('screen:0:0', 'Screen'),
        fakeSource('window:1:0', 'NVIDIA GeForce Overlay'),
        fakeSource('window:2:0', 'Program Manager'),
        fakeSource('window:3:0', 'Excel'),
      ]),
    })
    const names = (await listSources()).map((s) => s.name)
    expect(names).not.toContain('NVIDIA GeForce Overlay')
    expect(names).not.toContain('Program Manager')
    // A real application must survive the filter — hiding one would be worse
    // than showing an overlay the coach can simply skip past.
    expect(names).toContain('Excel')
  })

  it('trims the padded titles Windows reports for console windows', async () => {
    configureCapture({
      desktopCapturer: fakeCapturer([fakeSource('window:1:0', 'MINGW64:/          ')]),
    })
    expect((await listSources())[1].name).toBe('MINGW64:/')
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
    expect(resolved).toEqual({ kind: 'source', source: expect.objectContaining({ name: 'CoachBoard' }) })
  })

  it('resolves our own window to a frame capture, not a desktopCapturer source', () => {
    // Electron's enumeration omits our own windows, so this can never be found
    // by id — the main process turns it into webContents.mainFrame instead.
    setPendingSource(SELF_SOURCE_ID)
    expect(resolvePendingSource()).resolves.toEqual({ kind: 'self' })
  })

  it('resolves our own window even with no capturer injected', async () => {
    configureCapture({ desktopCapturer: null })
    setPendingSource(SELF_SOURCE_ID)
    expect(await resolvePendingSource()).toEqual({ kind: 'self' })
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

describe('minimised windows', () => {
  // Electron leaves minimised windows out; the window tools (Windows only) list
  // them under the same "window:<HWND>:0" id and restore one on demand.
  function tools(minimized: Array<{ id: string; name: string }>, onRestore: (id: string) => boolean = () => true) {
    const restored: string[] = []
    return {
      restored,
      listMinimized: () => minimized,
      restore: (id: string) => {
        restored.push(id)
        return onRestore(id)
      },
    }
  }

  it('lists them after the visible windows, marked minimised, without a thumbnail', async () => {
    configureCapture({ windowTools: tools([{ id: 'window:99:0', name: 'Training log.xlsx - Excel' }]) })
    const list = await listSources()
    const last = list[list.length - 1]
    expect(last).toEqual({ id: 'window:99:0', name: 'Training log.xlsx - Excel', kind: 'window', thumbnailDataUrl: null, minimized: true })
    expect(list.findIndex((s) => s.id === 'window:12:0')).toBeLessThan(list.length - 1)
  })

  it("never duplicates a window Electron already lists, or the app's own", async () => {
    configureCapture({
      ownSourceIds: () => ['window:77:0'],
      windowTools: tools([
        { id: 'window:12:0', name: 'CoachBoard' },
        { id: 'window:77:0', name: 'CoachBoard' },
        { id: 'window:55:0', name: 'Program Manager' },
      ]),
    })
    const list = await listSources()
    expect(list.filter((s) => s.id === 'window:12:0')).toHaveLength(1)
    expect(list.some((s) => s.minimized)).toBe(false)
  })

  it('still lists everything else when the window tools fail', async () => {
    configureCapture({ windowTools: { listMinimized: () => { throw new Error('user32 unavailable') }, restore: () => false } })
    expect((await listSources()).map((s) => s.id)).toContain('window:12:0')
  })

  it('restores a chosen minimised window and captures it once Electron sees it', async () => {
    let visible = false
    const restoredWindow = fakeSource('window:99:0', 'Training log.xlsx - Excel')
    configureCapture({
      desktopCapturer: { getSources: async () => (visible ? [...SOURCES, restoredWindow] : SOURCES) },
      windowTools: tools([], () => {
        setTimeout(() => { visible = true }, 200) // Windows takes a moment to draw it
        return true
      }),
    })
    setPendingSource('window:99:0')
    const resolved = await resolvePendingSource()
    expect(resolved).toEqual({ kind: 'source', source: restoredWindow })
  })

  it('does not restore anything for a window that is already listed', async () => {
    const t = tools([])
    configureCapture({ windowTools: t })
    setPendingSource('window:12:0')
    expect(await resolvePendingSource()).toMatchObject({ kind: 'source' })
    expect(t.restored).toEqual([])
  })

  it('refuses rather than recording something else when the window is gone', async () => {
    configureCapture({ windowTools: tools([], () => false) })
    setPendingSource('window:99:0')
    expect(await resolvePendingSource()).toBeNull()
  })

  it('gives up if a restored window never becomes capturable', async () => {
    configureCapture({ windowTools: tools([]) }) // restores, but never appears
    setPendingSource('window:99:0')
    expect(await resolvePendingSource()).toBeNull()
  }, 10_000)
})
