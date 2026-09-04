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
  /** Electron's NativeImage JPEG encoder. Quality is 0-100. */
  toJPEG(quality: number): Buffer
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
  kind: 'screen' | 'window' | 'self'
  thumbnailDataUrl: string | null
}

/**
 * CoachBoard's own window, which is NOT a desktopCapturer source.
 *
 * Electron's window enumeration omits the calling process's own windows, so the
 * one window the coach most wants to record — the program page they are talking
 * through — never appeared in the list. Rather than fight the enumeration, this
 * is captured through the frame itself (`webContents.mainFrame`), which the
 * display handler accepts in place of a source. That is better than window
 * capture anyway: it records the page, so nothing overlapping the window can
 * appear in the recording, and there is no desktop compositor in the path.
 */
export const SELF_SOURCE_ID = 'self:coachboard'

/**
 * Windows that are always present, never visible, and never worth recording.
 *
 * Matched exactly, and kept deliberately short. A broad heuristic here would
 * quietly hide a real application the coach wanted, which is a far worse
 * failure than showing one they have to skip past. These are English-only on
 * purpose: they are process-chrome names that Windows does not localise.
 */
const NEVER_USEFUL = new Set([
  'NVIDIA GeForce Overlay',
  'Program Manager',
  'Windows Input Experience',
  'Windows Shell Experience Host',
  'Microsoft Text Input Application',
])

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
 * Sized for a HiDPI display, not for the CSS box.
 *
 * 320px looked fine in the throwaway spike, which rendered these in a small
 * four-column grid, and visibly soft in the real picker, which renders them
 * roughly twice as large on a 2560-wide screen at fractional scaling. A
 * thumbnail the coach squints at defeats the point of having one.
 */
const THUMBNAIL = { width: 640, height: 360 }

/**
 * JPEG, not the PNG that toDataURL() produces.
 *
 * Quadrupling the pixel count would have quadrupled a lossless screenshot
 * encoding — several hundred KB per source, times a dozen sources, rebuilt every
 * time the dialog opens. JPEG at this quality is a fraction of the size and
 * indistinguishable at thumbnail scale, where the image is already a heavy
 * downscale of the original.
 */
const THUMBNAIL_QUALITY = 80

function encodeThumbnail(thumbnail: CapturerThumbnail): string | null {
  if (thumbnail.isEmpty()) return null
  // Older bundles predate toJPEG on this interface; fall back rather than throw.
  if (typeof thumbnail.toJPEG !== 'function') return thumbnail.toDataURL()
  return `data:image/jpeg;base64,${thumbnail.toJPEG(THUMBNAIL_QUALITY).toString('base64')}`
}

export async function listSources(): Promise<CaptureSourceDto[]> {
  if (!injectedCapturer) return []
  const sources = await injectedCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: THUMBNAIL,
  })

  const rest: CaptureSourceDto[] = sources
    .filter((s) => !NEVER_USEFUL.has(s.name.trim()))
    .map((s) => ({
      id: s.id,
      name: s.name.trim(),
      // Electron's own ids are prefixed by type; there is no other reliable
      // discriminator, and the picker groups by it.
      kind: s.id.startsWith('screen:') ? ('screen' as const) : ('window' as const),
      // An empty thumbnail is normal for a minimised window — the picker shows a
      // placeholder rather than a broken image.
      thumbnailDataUrl: encodeThumbnail(s.thumbnail),
    }))

  // CoachBoard first, then whole screens, then everything else: the order the
  // coach is most likely to want, rather than the order Windows enumerates in.
  const screens = rest.filter((s) => s.kind === 'screen')
  const windows = rest.filter((s) => s.kind === 'window')

  return [
    { id: SELF_SOURCE_ID, name: 'CoachBoard', kind: 'self', thumbnailDataUrl: null },
    ...screens,
    ...windows,
  ]
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

/**
 * What the display handler should capture.
 *
 * 'self' is not a desktopCapturer source at all — the main process turns it
 * into the window's own frame. Keeping that distinction in the return type
 * means the handler cannot accidentally treat one as the other.
 */
export type ResolvedCapture =
  | { kind: 'self' }
  | { kind: 'source'; source: CapturerSource }

/** Resolves the parked choice, or null if nothing was chosen or it is gone. */
export async function resolvePendingSource(): Promise<ResolvedCapture | null> {
  const id = takePendingSource()
  if (!id) return null
  if (id === SELF_SOURCE_ID) return { kind: 'self' }
  if (!injectedCapturer) return null
  // Re-listed rather than cached: a window that closed between the picker and
  // the capture must resolve to nothing instead of a stale handle.
  const sources = await injectedCapturer.getSources({ types: ['screen', 'window'] })
  const source = sources.find((s) => s.id === id)
  return source ? { kind: 'source', source } : null
}
