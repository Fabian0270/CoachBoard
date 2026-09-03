import { useCallback, useEffect, useRef, useState } from 'react'
import TrackerWorker from './tracker.worker?worker'
import type { TrackerRequest, TrackerResponse } from './tracker.worker'
import type { Frame, Sample, Seed, TrackResult } from './tracker.core'

/** A tracking run that frames are fed into as they are decoded. */
export interface TrackStream {
  /** Feeds one frame. Resolves with the bar position, or null once lost. */
  push: (frame: Frame) => Promise<Sample | null>
  /** Ends the run and resolves the full result. */
  finish: () => Promise<TrackResult>
  /** Abandons the run, releasing the worker's OpenCV state. */
  cancel: () => void
}

export type TrackerStatus = 'loading' | 'ready' | 'error'

/** Give up on a single frame rather than let one stall the whole capture. */
const FRAME_TIMEOUT_MS = 10_000

/**
 * Owns the tracking worker for one analysis page.
 *
 * The worker is spun up on mount so the ~10 MB opencv build is already compiled
 * by the time the coach has placed a point, and torn down on unmount so leaving
 * the page frees the wasm heap.
 */
export function useTracker(): {
  status: TrackerStatus
  error: string | null
  track: (frames: Frame[], seed: Seed) => Promise<TrackResult>
  openStream: (first: Frame, seed: Seed) => TrackStream
} {
  const workerRef = useRef<Worker | null>(null)
  const pending = useRef(new Map<number, { resolve: (r: TrackResult) => void; reject: (e: Error) => void }>())
  /** Streaming runs resolve one sample per frame, separately from the result. */
  const sampleWaiters = useRef(new Map<number, (s: Sample | null) => void>())
  const nextId = useRef(1)
  const [status, setStatus] = useState<TrackerStatus>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const worker = new TrackerWorker()
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent<TrackerResponse>) => {
      const msg = event.data
      if (msg.type === 'ready') {
        setStatus('ready')
        return
      }
      if (msg.type === 'sample') {
        const waiter = sampleWaiters.current.get(msg.id)
        sampleWaiters.current.delete(msg.id)
        waiter?.(msg.sample)
        return
      }
      if (msg.type === 'result') {
        pending.current.get(msg.id)?.resolve(msg.result)
        pending.current.delete(msg.id)
        return
      }
      if (msg.id !== undefined) {
        pending.current.get(msg.id)?.reject(new Error(msg.message))
        pending.current.delete(msg.id)
        // Unblock any frame that was waiting on this run, or the capture loop
        // sits forever on a promise the worker will never answer.
        sampleWaiters.current.get(msg.id)?.(null)
        sampleWaiters.current.delete(msg.id)
      } else {
        setError(msg.message)
        setStatus('error')
      }
    }
    worker.onerror = (e: ErrorEvent) => {
      setError(e.message || 'The analyser failed to start')
      setStatus('error')
    }
    worker.postMessage({ type: 'init' } satisfies TrackerRequest)

    return () => {
      worker.terminate()
      workerRef.current = null
      // Reject rather than drop: leaving these unsettled means an in-flight
      // capture on the page never learns the analyser went away.
      for (const p of pending.current.values()) p.reject(new Error('The analyser was closed'))
      pending.current.clear()
      for (const w of sampleWaiters.current.values()) w(null)
      sampleWaiters.current.clear()
    }
  }, [])

  const track = useCallback((frames: Frame[], seed: Seed) => {
    const worker = workerRef.current
    if (!worker) return Promise.reject(new Error('The analyser is not running'))
    const id = nextId.current++
    return new Promise<TrackResult>((resolve, reject) => {
      pending.current.set(id, { resolve, reject })
      // Frames are tens of megabytes, so their buffers are TRANSFERRED rather
      // than copied. They are detached on this side afterwards, which is fine —
      // nothing reads them again once tracking owns them.
      worker.postMessage(
        { type: 'track', id, frames, seed } satisfies TrackerRequest,
        frames.map((f) => f.data.buffer),
      )
    })
  }, [])

  /**
   * Starts a streaming run. Frames are pushed as they decode, so memory stays
   * constant and the path can be drawn while tracking is still going.
   */
  const openStream = useCallback((first: Frame, seed: Seed): TrackStream => {
    const worker = workerRef.current
    const id = nextId.current++
    let closed = false

    const awaitSample = (): Promise<Sample | null> =>
      new Promise<Sample | null>((resolve) => {
        sampleWaiters.current.set(id, resolve)
        // A frame that never comes back would stall the whole capture with no
        // way out — the exact failure that left "Reading frames…" on screen
        // indefinitely. One slow frame is not worth hanging over.
        setTimeout(() => {
          if (sampleWaiters.current.get(id) === resolve) {
            sampleWaiters.current.delete(id)
            resolve(null)
          }
        }, FRAME_TIMEOUT_MS)
      })

    if (!worker) {
      return {
        push: () => Promise.resolve(null),
        finish: () => Promise.reject(new Error('The analyser is not running')),
        cancel: () => {},
      }
    }

    const started = awaitSample()
    worker.postMessage({ type: 'streamStart', id, first, seed } satisfies TrackerRequest, [
      first.data.buffer,
    ])

    return {
      async push(frame) {
        if (closed) return null
        await started
        const next = awaitSample()
        // Transferred, not copied: a frame is ~half a megabyte and nothing on
        // this side reads it again once tracking owns it.
        worker.postMessage({ type: 'streamFrame', id, frame } satisfies TrackerRequest, [
          frame.data.buffer,
        ])
        return next
      },
      finish() {
        if (closed) return Promise.reject(new Error('That tracking run already finished'))
        closed = true
        return new Promise<TrackResult>((resolve, reject) => {
          pending.current.set(id, { resolve, reject })
          worker.postMessage({ type: 'streamEnd', id } satisfies TrackerRequest)
        })
      },
      cancel() {
        if (closed) return
        closed = true
        // Tell the worker to release its OpenCV state; the result is discarded.
        worker.postMessage({ type: 'streamEnd', id } satisfies TrackerRequest)
        sampleWaiters.current.delete(id)
        pending.current.delete(id)
      },
    }
  }, [])

  return { status, error, track, openStream }
}
