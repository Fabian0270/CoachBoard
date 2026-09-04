import { useCallback, useRef, useState } from 'react'
import { createCompositor, type BubbleCorner, type Compositor } from './compositor'
import {
  isCapturing,
  nextState,
  planEncoding,
  type RecorderEvent,
  type RecorderState,
} from './recorder.core'

// ---------------------------------------------------------------------------
// Everything stateful about a recording: streams, the compositor, MediaRecorder,
// and getting the bytes onto disk as they are produced.
//
// This hook is used by exactly one component — RecorderProvider — which is
// mounted ABOVE the router. That is not a style choice: the recorder previously
// lived on a page, and clicking through the app unmounted it mid-recording and
// stopped the capture. Talking the athlete through several screens is the
// feature, so the recorder cannot be owned by any screen.
// ---------------------------------------------------------------------------

export interface RecorderOptions {
  sourceId: string
  camera: boolean
  microphone: boolean
  systemAudio: boolean
  cameraDeviceId?: string
  microphoneDeviceId?: string
}

export interface RecorderEngine {
  state: RecorderState
  /** Bytes confirmed on disk. The honest number, not an estimate. */
  bytes: number
  elapsedMs: number
  recordingId: string | null
  error: string | null
  webcamStream: MediaStream | null
  bubbleCorner: BubbleCorner
  setBubbleCorner(corner: BubbleCorner): void
  send(event: RecorderEvent): void
  start(options: RecorderOptions): Promise<void>
  pause(): void
  resume(): void
  stop(): void
  discard(): Promise<void>
  reset(): void
}

/** How often MediaRecorder hands over bytes. Short enough that a crash loses little. */
const TIMESLICE_MS = 3000

export function useRecorderEngine(): RecorderEngine {
  const [state, setState] = useState<RecorderState>('idle')
  const [bytes, setBytes] = useState(0)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [recordingId, setRecordingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [webcamStream, setWebcamStream] = useState<MediaStream | null>(null)
  const [bubbleCorner, setBubbleCornerState] = useState<BubbleCorner>('bottom-right')

  const compositorRef = useRef<Compositor | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamsRef = useRef<MediaStream[]>([])
  const audioCtxRef = useRef<AudioContext | null>(null)
  const idRef = useRef<string | null>(null)
  const timerRef = useRef<number | null>(null)
  const startedAtRef = useRef(0)
  const pausedForMsRef = useRef(0)
  const pausedAtRef = useRef(0)

  /**
   * Chunks are POSTed one at a time, chained rather than in parallel.
   *
   * They are appended to a single file on the server, so two in flight at once
   * would interleave and corrupt the recording. Same promise-chain idiom the
   * frame capture in captureFrames.ts uses to keep frames in order.
   */
  const uploadChain = useRef<Promise<void>>(Promise.resolve())

  const send = useCallback((event: RecorderEvent) => {
    setState((current) => nextState(current, event) ?? current)
  }, [])

  const teardown = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current)
    timerRef.current = null
    compositorRef.current?.stop()
    compositorRef.current = null
    recorderRef.current = null
    for (const stream of streamsRef.current) {
      for (const track of stream.getTracks()) track.stop()
    }
    streamsRef.current = []
    void audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
    setWebcamStream(null)
  }, [])

  const start = useCallback(
    async (options: RecorderOptions) => {
      setError(null)
      setBytes(0)
      setElapsedMs(0)
      pausedForMsRef.current = 0
      uploadChain.current = Promise.resolve()

      try {
        // Park the choice for the main process, which refuses to capture
        // anything the coach did not explicitly pick.
        const parked = await fetch('/api/recorder/source', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: options.sourceId }),
        })
        if (!parked.ok) throw new Error((await parked.json()).error ?? 'Could not select a source')

        const display = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: options.systemAudio,
        })
        streamsRef.current.push(display)

        const videoTrack = display.getVideoTracks()[0]
        const settings = videoTrack?.getSettings() ?? {}
        const plan = planEncoding(settings.width ?? 0, settings.height ?? 0)

        let webcam: MediaStream | null = null
        if (options.camera) {
          webcam = await navigator.mediaDevices.getUserMedia({
            video: options.cameraDeviceId
              ? { deviceId: { exact: options.cameraDeviceId } }
              : { width: 640, height: 480 },
          })
          streamsRef.current.push(webcam)
          setWebcamStream(webcam)
        }

        let mic: MediaStream | null = null
        if (options.microphone) {
          mic = await navigator.mediaDevices.getUserMedia({
            audio: options.microphoneDeviceId
              ? { deviceId: { exact: options.microphoneDeviceId } }
              : true,
          })
          streamsRef.current.push(mic)
        }

        const compositor = createCompositor({ display, webcam, plan, corner: bubbleCorner })
        compositorRef.current = compositor

        const mixed = new MediaStream(compositor.stream.getVideoTracks())
        const audioSources = [mic, display].filter(
          (s): s is MediaStream => !!s && s.getAudioTracks().length > 0,
        )
        if (audioSources.length > 0) {
          // Two separate tracks, and MediaRecorder takes one — so they are summed
          // in a graph rather than merely both attached.
          const audioCtx = new AudioContext()
          audioCtxRef.current = audioCtx
          const destination = audioCtx.createMediaStreamDestination()
          for (const source of audioSources) {
            audioCtx.createMediaStreamSource(source).connect(destination)
          }
          for (const track of destination.stream.getAudioTracks()) mixed.addTrack(track)
        }

        const { id } = (await (
          await fetch('/api/recorder/recordings', { method: 'POST' })
        ).json()) as { id: string }
        idRef.current = id
        setRecordingId(id)

        const preferred = [
          'video/webm;codecs=vp9,opus',
          'video/webm;codecs=vp8,opus',
          'video/webm',
        ]
        const mimeType = preferred.find((t) => MediaRecorder.isTypeSupported(t))

        const recorder = new MediaRecorder(mixed, {
          mimeType,
          videoBitsPerSecond: plan.videoBitsPerSecond,
          audioBitsPerSecond: plan.audioBitsPerSecond,
        })
        recorderRef.current = recorder

        recorder.ondataavailable = (e) => {
          if (e.data.size === 0) return
          uploadChain.current = uploadChain.current
            .then(async () => {
              const res = await fetch(`/api/recorder/recordings/${id}/chunk`, {
                method: 'POST',
                headers: { 'Content-Type': 'video/webm' },
                body: e.data,
              })
              if (!res.ok) throw new Error((await res.json()).error ?? 'Chunk rejected')
              const { bytes: written } = (await res.json()) as { bytes: number }
              setBytes(written)
            })
            .catch((err: unknown) => {
              // Losing a chunk corrupts everything after it, so stop rather than
              // carry on producing a file that will not play.
              setError(err instanceof Error ? err.message : 'Could not save the recording')
              if (recorder.state !== 'inactive') recorder.stop()
            })
        }

        // Without this an encoder failure ends the recording silently — the
        // coach keeps talking to a recorder that stopped listening.
        recorder.onerror = () => {
          setError('The recorder stopped unexpectedly. Whatever was captured is kept.')
          if (recorder.state !== 'inactive') recorder.stop()
        }

        recorder.onstop = () => {
          void uploadChain.current
            .then(() => fetch(`/api/recorder/recordings/${id}/finish`, { method: 'POST' }))
            .then(async (res) => {
              if (!res.ok) throw new Error((await res.json()).error ?? 'Could not finish')
              const info = (await res.json()) as { bytes: number }
              setBytes(info.bytes)
              send('finalized')
            })
            .catch((err: unknown) => {
              setError(err instanceof Error ? err.message : 'Could not finish the recording')
              send('failed')
            })
            .finally(teardown)
        }

        // Stopping the share from the OS must end the recording too, or it keeps
        // writing against a dead source.
        videoTrack?.addEventListener('ended', () => {
          if (recorder.state !== 'inactive') recorder.stop()
          send('stop')
        })

        recorder.start(TIMESLICE_MS)
        startedAtRef.current = performance.now()
        timerRef.current = window.setInterval(() => {
          if (pausedAtRef.current) return
          setElapsedMs(performance.now() - startedAtRef.current - pausedForMsRef.current)
        }, 250)
        send('countdownDone')
      } catch (err) {
        // getDisplayMedia rejects with NotAllowedError when the coach cancels,
        // which is not an error worth shouting about.
        const name = err instanceof Error ? err.name : ''
        if (name !== 'NotAllowedError') {
          setError(err instanceof Error ? err.message : String(err))
        }
        teardown()
        send('failed')
      }
    },
    [bubbleCorner, send, teardown],
  )

  const pause = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state !== 'recording') return
    recorder.pause()
    pausedAtRef.current = performance.now()
    send('pause')
  }, [send])

  const resume = useCallback(() => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state !== 'paused') return
    recorder.resume()
    pausedForMsRef.current += performance.now() - pausedAtRef.current
    pausedAtRef.current = 0
    send('resume')
  }, [send])

  const stop = useCallback(() => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      send('stop')
      recorder.stop()
      return
    }
    teardown()
    send('failed')
  }, [send, teardown])

  const discard = useCallback(async () => {
    const id = idRef.current
    idRef.current = null
    setRecordingId(null)
    teardown()
    send('discard')
    if (id) await fetch(`/api/recorder/recordings/${id}`, { method: 'DELETE' }).catch(() => {})
  }, [send, teardown])

  const reset = useCallback(() => {
    teardown()
    idRef.current = null
    setRecordingId(null)
    setError(null)
    setBytes(0)
    setElapsedMs(0)
  }, [teardown])

  const setBubbleCorner = useCallback((corner: BubbleCorner) => {
    setBubbleCornerState(corner)
    compositorRef.current?.setCorner(corner)
  }, [])

  return {
    state,
    bytes,
    elapsedMs,
    recordingId,
    error,
    webcamStream,
    bubbleCorner,
    setBubbleCorner,
    send,
    start,
    pause,
    resume,
    stop,
    discard,
    reset,
  }
}

export { isCapturing }
