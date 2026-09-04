// ---------------------------------------------------------------------------
// Screen-capture source seam for Feature 11c.
//
// Same injection pattern as systemService and secureStore, and for the same
// reason: the Express server runs inside the Electron main process, but
// importing `electron` here would break the plain-Node test runner.
//
// It exists at all because Electron 33's `useSystemPicker: true` does not
// engage on Windows — measured, not assumed: every capture in the 11c spike
// logged "system picker unavailable" and silently grabbed the whole primary
// screen. The coach has to be able to choose, so the picker is ours to build,
// and the choice has to travel from the renderer to the main process. This app
// has no preload and no IPC by design, so it travels over the same HTTP
// connection everything else uses.
// ---------------------------------------------------------------------------

export interface CapturerThumbnail {
  toDataURL(): string
  isEmpty(): boolean
}

export interface CapturerSource {
  id: string
  name: string
  thumbnail: CapturerThumbnail
}

export interface DesktopCapturerLike {
  getSources(opts: {
    types: Array<'window' | 'screen'>
    thumbnailSize?: { width: number; height: number }
    fetchWindowIcons?: boolean
  }): Promise<CapturerSource[]>
}

/** What the picker renders. The thumbnail is a data URL, already sized down. */
export interface CaptureSourceDto {
  id: string
  name: string
  kind: 'screen' | 'window'
  thumbnailDataUrl: string | null
}

let injectedCapturer: DesktopCapturerLike | null = null

/** Wired once at startup by the Electron main process (and by tests with fakes). */
export function configureCapture(opts: { desktopCapturer?: DesktopCapturerLike | null }): void {
  if ('desktopCapturer' in opts) injectedCapturer = opts.desktopCapturer ?? null
}

/** False outside Electron, so the UI can explain rather than offer a dead button. */
export function canCapture(): boolean {
  return injectedCapturer !== null
}

/**
 * Small enough that a dozen of them are a cheap JSON payload, large enough to
 * tell two windows of the same app apart — which is the entire job of the
 * picker's thumbnail.
 */
const THUMBNAIL = { width: 320, height: 180 }

export async function listSources(): Promise<CaptureSourceDto[]> {
  if (!injectedCapturer) return []
  const sources = await injectedCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: THUMBNAIL,
  })
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    // Electron's own ids are prefixed by type; there is no other reliable
    // discriminator, and the picker groups by it.
    kind: s.id.startsWith('screen:') ? 'screen' : 'window',
    // An empty thumbnail is normal for a minimised window — the picker shows a
    // placeholder rather than a broken image.
    thumbnailDataUrl: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
  }))
}

let pendingSourceId: string | null = null

/** Parked by the renderer immediately before it calls getDisplayMedia. */
export function setPendingSource(id: string | null): void {
  pendingSourceId = id
}

/**
 * Read once and cleared.
 *
 * Consuming rather than peeking is deliberate: a choice left behind by an
 * abandoned preflight must not silently decide what a later, unrelated capture
 * records. If nothing is pending, the request is refused rather than defaulted
 * to a screen the coach never picked.
 */
export function takePendingSource(): string | null {
  const id = pendingSourceId
  pendingSourceId = null
  return id
}

/** Resolves the parked choice to a live source, or null if it is gone. */
export async function resolvePendingSource(): Promise<CapturerSource | null> {
  const id = takePendingSource()
  if (!id || !injectedCapturer) return null
  // Re-listed rather than cached: a window that closed between the picker and
  // the capture must resolve to nothing instead of a stale handle.
  const sources = await injectedCapturer.getSources({ types: ['screen', 'window'] })
  return sources.find((s) => s.id === id) ?? null
}
