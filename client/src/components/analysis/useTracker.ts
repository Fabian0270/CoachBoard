import { useCallback, useEffect, useRef, useState } from 'react'
import TrackerWorker from './tracker.worker?worker'
import type { TrackerRequest, TrackerResponse } from './tracker.worker'
import type { Frame, Seed, TrackResult } from './tracker.core'

export type TrackerStatus = 'loading' | 'ready' | 'error'

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
} {
  const workerRef = useRef<Worker | null>(null)
  const pending = useRef(new Map<number, { resolve: (r: TrackResult) => void; reject: (e: Error) => void }>())
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
      if (msg.type === 'result') {
        pending.current.get(msg.id)?.resolve(msg.result)
        pending.current.delete(msg.id)
        return
      }
      if (msg.id !== undefined) {
        pending.current.get(msg.id)?.reject(new Error(msg.message))
        pending.current.delete(msg.id)
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
      pending.current.clear()
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

  return { status, error, track }
}
