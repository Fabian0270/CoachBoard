/// <reference lib="webworker" />
import {
  createTracker,
  trackFrames,
  type Frame,
  type Sample,
  type Seed,
  type StreamingTracker,
  type TrackResult,
} from './tracker.core'

// ---------------------------------------------------------------------------
// Runs opencv.js off the main thread.
//
// This is not an optimisation, it is a requirement: the vendored build is ~10 MB
// with the wasm embedded, and compiling it on the main thread freezes the window
// for tens of seconds — no spinner, no paint, nothing. In a worker the page
// stays live and can honestly say it is still preparing.
//
// It must be a CLASSIC worker, not a module one: importScripts does not exist in
// module workers, and opencv.js is an Emscripten script rather than an ES
// module. Vite's default worker.format ('iife') gives us that.
//
// Two build-specific quirks live in this file, each diagnosed by running the
// real thing rather than reading the config, and each invisible until it was:
// a worker that boots cleanly, imports cleanly, and then hangs forever with no
// error. See patchDataUriFetch() and the comment on loadCv() below.
// ---------------------------------------------------------------------------

declare const self: DedicatedWorkerGlobalScope & { cv?: unknown }

/**
 * Chromium's fetch() throws `TypeError: Failed to fetch` for a large `data:`
 * URI when called from inside a Worker — confirmed directly: a ~10 KB data URI
 * fetches fine, a ~10 MB one fails every time. This is a real engine
 * limitation, not a CSP or credentials issue (a `data:` URI is same-origin by
 * definition).
 *
 * The vendored single-file opencv.js build embeds its ~7.5 MB wasm binary as
 * exactly such a `data:` URI and loads it with `fetch(wasmBinaryFile, {
 * credentials: 'same-origin' })`. That call fails, and the failure is fatal:
 * Emscripten's own glue swallows the rejection rather than propagating it, so
 * the module's initialisation promise simply never settles. No error, no
 * timeout — the worker boots, imports the script without incident, and hangs
 * forever with nothing to show why.
 *
 * Fixed by intercepting fetch() for `data:` URIs and decoding them locally
 * with atob() instead of asking Chromium to fetch them. Measured at well under
 * a second for the real payload. Installed before importScripts runs, since
 * that is the call that reads `wasmBinaryFile` and invokes fetch on it.
 */
function patchDataUriFetch(): void {
  const nativeFetch = self.fetch.bind(self)
  self.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === 'string' && input.startsWith('data:')) {
      try {
        const comma = input.indexOf(',')
        const meta = input.slice(5, comma)
        const isBase64 = meta.endsWith(';base64')
        const payload = input.slice(comma + 1)
        const decoded = isBase64 ? atob(payload) : decodeURIComponent(payload)
        const bytes = new Uint8Array(decoded.length)
        for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i)
        return Promise.resolve(new Response(bytes, { status: 200 }))
      } catch (err) {
        // Reject rather than throw: a synchronous throw here would skip any
        // .catch() the caller attached, which is worse than an honest rejection.
        return Promise.reject(err instanceof Error ? err : new Error(String(err)))
      }
    }
    return nativeFetch(input, init)
  }
}

export type TrackerRequest =
  | { type: 'init' }
  | { type: 'track'; id: number; frames: Frame[]; seed: Seed }
  // Streaming: one frame at a time, so memory stays constant however long the
  // clip is and the path can be drawn while it is still being tracked.
  | { type: 'streamStart'; id: number; first: Frame; seed: Seed }
  | { type: 'streamFrame'; id: number; frame: Frame }
  | { type: 'streamEnd'; id: number }

export type TrackerResponse =
  | { type: 'ready' }
  | { type: 'error'; id?: number; message: string }
  | { type: 'result'; id: number; result: TrackResult }
  /** One tracked position, or null for the frame where the bar was lost. */
  | { type: 'sample'; id: number; sample: Sample | null }

/** How long to wait for the wasm runtime before calling it a failure. */
const RUNTIME_TIMEOUT_MS = 30_000

type CvModule = {
  calcOpticalFlowPyrLK?: unknown
  onRuntimeInitialized?: () => void
  /** This build's factory call returns a promise that resolves to the real
   *  module — `cv` itself is that promise, not the module, until awaited. */
  then?: (onOk: (m: unknown) => void, onErr: (e: unknown) => void) => void
}

/**
 * Wrapped in `{ value }` rather than resolving directly to the module, because
 * the RESOLVED module object itself still carries a `.then` — confirmed by
 * inspection, not assumed. Handing a value with `.then` to `resolve()`, or
 * returning one from inside a `.then()` callback, is treated by the Promise
 * spec as a thenable and re-adopted rather than fulfilled: the chain goes back
 * to waiting on `module.then(...)` again, forever. That happened at two
 * separate points before this wrapper — resolving `loadCvWrapped`'s own
 * promise with the bare module, and then again in a plain `.then(w => w.value)`
 * unwrap on top of it. Wrapping in a plain object with no `.then` of its own,
 * and requiring every caller to destructure `.value`, is what keeps the
 * thenable from ever being handed to a promise as its resolution value.
 */
let cvReady: Promise<{ value: unknown }> | null = null

function loadCv(): Promise<{ value: unknown }> {
  if (!cvReady) cvReady = loadCvWrapped()
  return cvReady
}

function loadCvWrapped(): Promise<{ value: unknown }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('opencv.js never finished initialising')),
      RUNTIME_TIMEOUT_MS,
    )
    const succeed = (module: CvModule) => {
      clearTimeout(timeout)
      if (typeof module?.calcOpticalFlowPyrLK !== 'function') {
        reject(new Error('opencv.js initialised without optical flow'))
        return
      }
      self.cv = module
      resolve({ value: module })
    }
    const fail = (err: unknown) => {
      clearTimeout(timeout)
      reject(err instanceof Error ? err : new Error(String(err)))
    }

    patchDataUriFetch()

    try {
      // Served straight from client/public — never bundled, never from a CDN.
      self.importScripts('/vendor/opencv/opencv.js')
    } catch (err) {
      fail(new Error(`Could not load opencv.js: ${(err as Error).message}`))
      return
    }

    const loaded = self.cv as CvModule | undefined
    if (!loaded) {
      fail(new Error('opencv.js did not define cv'))
      return
    }

    if (typeof loaded.then === 'function') {
      // The path this build actually takes — see the class doc comment above.
      loaded.then((module) => succeed(module as CvModule), fail)
    } else if (typeof loaded.calcOpticalFlowPyrLK === 'function') {
      succeed(loaded) // already initialised
    } else {
      // Fallback for a build that uses the documented hook instead.
      loaded.onRuntimeInitialized = () => succeed(self.cv as CvModule)
    }
  })
}

/** The in-flight streaming track, if any. Only one runs at a time. */
let stream: { id: number; tracker: StreamingTracker } | null = null

function endStream(): void {
  stream?.tracker.dispose()
  stream = null
}

self.onmessage = async (event: MessageEvent<TrackerRequest>) => {
  const msg = event.data
  try {
    const { value: cv } = await loadCv()
    if (msg.type === 'init') {
      self.postMessage({ type: 'ready' } satisfies TrackerResponse)
      return
    }
    if (msg.type === 'track') {
      const result = trackFrames(cv, msg.frames, msg.seed)
      self.postMessage({ type: 'result', id: msg.id, result } satisfies TrackerResponse)
      return
    }
    if (msg.type === 'streamStart') {
      // A previous run that was never ended (the coach navigated away
      // mid-track) still holds OpenCV Mats — release them before starting.
      endStream()
      stream = { id: msg.id, tracker: createTracker(cv, msg.first, msg.seed) }
      self.postMessage({
        type: 'sample',
        id: msg.id,
        sample: stream.tracker.samples[0] ?? null,
      } satisfies TrackerResponse)
      return
    }
    if (msg.type === 'streamFrame') {
      // Late frames from a superseded run are ignored rather than corrupting
      // the current one.
      if (stream?.id !== msg.id) return
      const sample = stream.tracker.push(msg.frame)
      self.postMessage({ type: 'sample', id: msg.id, sample } satisfies TrackerResponse)
      return
    }
    if (msg.type === 'streamEnd') {
      if (stream?.id !== msg.id) return
      const result: TrackResult = {
        samples: stream.tracker.samples,
        quality: stream.tracker.quality,
      }
      endStream()
      self.postMessage({ type: 'result', id: msg.id, result } satisfies TrackerResponse)
      return
    }
  } catch (err) {
    endStream()
    self.postMessage({
      type: 'error',
      // Carry the id for every request that has one, so the caller's pending
      // promise rejects instead of hanging. Only 'init' has no id, and that is
      // the case that should surface as a whole-analyser failure.
      id: msg.type === 'init' ? undefined : msg.id,
      message: err instanceof Error ? err.message : String(err),
    } satisfies TrackerResponse)
  }
}
