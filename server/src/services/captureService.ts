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
  /** A minimised window: no thumbnail, and it is restored when recording starts. */
  minimized?: boolean
}

/**
 * Minimised windows, which Electron's list leaves out (Windows only; see
 * electron/src/minimizedWindows.ts). Ids use desktopCapturer's own format, so a
 * restored window is found in getSources under the same id.
 */
export interface WindowToolsLike {
  listMinimized(): Array<{ id: string; name: string }>
  restore(id: string): boolean
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
/** Capture ids of the app's own windows. See listSources. */
let ownSourceIds: () => string[] = () => []
let windowTools: WindowToolsLike | null = null

/** Wired once at startup by the Electron main process (and by tests with fakes). */
export function configureCapture(opts: {
  desktopCapturer?: DesktopCapturerLike | null
  ownSourceIds?: () => string[]
  windowTools?: WindowToolsLike | null
}): void {
  if ('desktopCapturer' in opts) injectedCapturer = opts.desktopCapturer ?? null
  if ('ownSourceIds' in opts) ownSourceIds = opts.ownSourceIds ?? (() => [])
  if ('windowTools' in opts) windowTools = opts.windowTools ?? null
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

  // Electron 33 left our own window out of the list; from 45 it is in it. It is
  // already offered first as "CoachBoard" (the 'self' entry, captured by frame),
  // so the window copy would only be a confusing duplicate.
  const own = new Set(ownSourceIds())
  const rest: CaptureSourceDto[] = sources
    .filter((s) => !own.has(s.id))
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
    // Last: they cannot show a preview, and recording one first restores it.
    ...listMinimized(new Set([...own, ...rest.map((s) => s.id)])),
  ]
}

/**
 * Minimised windows Electron did not list. Best-effort: a failure here leaves
 * the coach with Electron's list, which is what they had before.
 */
function listMinimized(skip: Set<string>): CaptureSourceDto[] {
  if (!windowTools) return []
  try {
    return windowTools
      .listMinimized()
      .filter((w) => !skip.has(w.id) && !NEVER_USEFUL.has(w.name.trim()))
      .map((w) => ({ id: w.id, name: w.name.trim(), kind: 'window' as const, thumbnailDataUrl: null, minimized: true }))
  } catch {
    return []
  }
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
  // No thumbnails: only the id is needed here, and drawing a preview of every
  // open window on each check is what made starting a recording slow.
  const find = async () =>
    (await injectedCapturer!.getSources({ types: ['screen', 'window'], thumbnailSize: NO_THUMBNAIL })).find(
      (s) => s.id === id,
    ) ?? null
  const source = await find()
  if (source) return { kind: 'source', source }

  // Not listed: a minimised window (Windows cannot capture one — it is not
  // drawn). Restore it, then wait for Electron to see it. Same id either way.
  if (!windowTools || !id.startsWith('window:')) return null
  let restored = false
  try {
    restored = windowTools.restore(id)
  } catch {
    restored = false
  }
  if (!restored) return null
  for (let waited = 0; waited < RESTORE_WAIT_MS; waited += RESTORE_POLL_MS) {
    await new Promise((resolve) => setTimeout(resolve, RESTORE_POLL_MS))
    const appeared = await find()
    if (appeared) return { kind: 'source', source: appeared }
  }
  return null
}

/** How long to wait for a restored window to become capturable. Measured at well under a second. */
const RESTORE_WAIT_MS = 2000
const RESTORE_POLL_MS = 150
/** Electron skips capturing previews entirely at this size. */
const NO_THUMBNAIL = { width: 0, height: 0 }
