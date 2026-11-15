import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { HEARTBEAT_MS, openControlsChannel, type ControlsMessage } from './controlsChannel'
import { useToast } from '../ui/toast'
import PreflightDialog from './PreflightDialog'
import RecordingPill from './RecordingPill'
import ReviewDialog from './ReviewDialog'
import { isCapturing } from './recorder.core'
import { useRecorderEngine, type RecorderOptions } from './useRecorderEngine'
import { useUnsavedWork } from '../../lib/unsavedWork'

// ---------------------------------------------------------------------------
// Mounted ABOVE the router, on purpose.
//
// The recorder used to live on a page. Clicking through the app while recording
// unmounted it and stopped the capture — and clicking through the app while
// talking IS the feature: the coach explains a program by walking the athlete
// across several screens. So the recorder is owned by the app, not by a screen,
// and every route change happens underneath it.
// ---------------------------------------------------------------------------

interface RecorderContextValue {
  /** Opens the preflight. No-op while a recording is already in progress. */
  startRecording(): void
  isRecording: boolean
}

const RecorderContext = createContext<RecorderContextValue | null>(null)

export function useRecorder(): RecorderContextValue {
  const ctx = useContext(RecorderContext)
  if (!ctx) throw new Error('useRecorder must be used inside RecorderProvider')
  return ctx
}

/** Same id as SELF_SOURCE_ID in server/src/services/captureService.ts. */
const SELF_SOURCE_ID = 'self:coachboard'

export default function RecorderProvider({ children }: { children: React.ReactNode }) {
  const engine = useRecorderEngine()
  const toast = useToast()
  const [saved, setSaved] = useState(false)
  // Read in callbacks that must not be re-created when the flag changes.
  const savedRef = useRef(false)

  const startRecording = useCallback(() => {
    if (engine.state !== 'idle' && engine.state !== 'review') return
    setSaved(false)
    savedRef.current = false
    engine.send('open')
  }, [engine])

  // Any source other than CoachBoard itself gets the floating bar from the main
  // process, so the in-app pill would be a second set of controls — and, when the
  // whole screen is recorded, one that appears in the video.
  const [barIsOpen, setBarIsOpen] = useState(false)

  const onStart = useCallback(
    (options: RecorderOptions) => {
      setBarIsOpen(options.sourceId !== SELF_SOURCE_ID)
      engine.send('start')
      void engine.start(options)
    },
    [engine],
  )

  const onDiscard = useCallback(() => {
    void engine.discard()
    if (!savedRef.current) toast.info('Recording discarded.')
  }, [engine, toast])

  const onSaved = useCallback(() => {
    setSaved(true)
    savedRef.current = true
    toast.success('Saved. Choose where to keep it in the download prompt.')
  }, [toast])

  /**
   * Sending counts as keeping it: the athlete has the video, so closing the
   * dialog afterwards is a normal finish rather than something to warn about.
   */
  const onSent = useCallback(() => {
    savedRef.current = true
    toast.success('Sent.')
    void engine.discard()
  }, [engine, toast])

  // A recording is scratch space until it is saved or sent, so closing during
  // one — or with an unsaved take waiting in review — loses it.
  useUnsavedWork(
    'recording',
    isCapturing(engine.state) ||
      engine.state === 'finalizing' ||
      (engine.state === 'review' && !saved),
  )

  // The floating controls bar (see controlsChannel.ts). When the coach records
  // another window or the whole screen, CoachBoard is usually behind it and the
  // pill below is out of reach, so the main process opens a small always-on-top
  // bar. It mirrors this recorder's state and sends commands back.
  const engineRef = useRef(engine)
  engineRef.current = engine
  const channelRef = useRef<BroadcastChannel | null>(null)
  const publish = useCallback(() => {
    const { state, elapsedMs, bytes } = engineRef.current
    channelRef.current?.postMessage({ type: 'state', state, elapsedMs, bytes } satisfies ControlsMessage)
  }, [])
  useEffect(() => {
    const channel = openControlsChannel()
    channelRef.current = channel
    if (!channel) return
    const onMessage = (event: MessageEvent<ControlsMessage>) => {
      const message = event.data
      if (message.type === 'hello') publish()
      if (message.type !== 'command') return
      const current = engineRef.current
      if (message.action === 'pause' && current.state === 'recording') current.pause()
      if (message.action === 'resume' && current.state === 'paused') current.resume()
      if (message.action === 'stop' && isCapturing(current.state)) current.stop()
    }
    channel.addEventListener('message', onMessage)
    return () => {
      channel.removeEventListener('message', onMessage)
      channel.close()
      channelRef.current = null
    }
  }, [publish])
  // On every change, plus a heartbeat while capturing so the bar can tell the
  // recorder is still alive (and close itself if the main window goes away).
  useEffect(publish, [engine.state, engine.elapsedMs, engine.bytes, publish])
  useEffect(() => {
    if (!isCapturing(engine.state)) return
    const timer = window.setInterval(publish, HEARTBEAT_MS)
    return () => window.clearInterval(timer)
  }, [engine.state, publish])

  const value = useMemo(
    () => ({ startRecording, isRecording: isCapturing(engine.state) }),
    [startRecording, engine.state],
  )

  return (
    <RecorderContext.Provider value={value}>
      {children}

      {engine.state === 'preflight' && (
        <PreflightDialog onStart={onStart} onCancel={() => engine.send('cancel')} />
      )}

      {isCapturing(engine.state) && !barIsOpen && (
        <RecordingPill
          elapsedMs={engine.elapsedMs}
          bytes={engine.bytes}
          paused={engine.state === 'paused'}
          onPause={engine.pause}
          onResume={engine.resume}
          onStop={engine.stop}
        />
      )}

      {engine.state === 'finalizing' && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full border border-border bg-card px-4 py-2 text-sm shadow-lg">
          Finishing the recording…
        </div>
      )}

      {engine.state === 'review' && engine.recordingId && (
        <ReviewDialog
          recordingId={engine.recordingId}
          bytes={engine.bytes}
          error={engine.error}
          cameraOffsetMs={engine.cameraOffsetMs}
          corner={engine.bubbleCorner}
          onSaved={onSaved}
          onSent={onSent}
          onDiscard={onDiscard}
        />
      )}

      {/* A failure before anything was captured has no review to surface it. */}
      {engine.state === 'idle' && engine.error && <ErrorToast engine={engine} />}

      {/* The webcam bubble is drawn INTO the recording by the compositor rather
          than shown here, so it appears over whatever is being recorded —
          including a window that is not ours. Nothing to render on the page. */}
      {saved && null}
    </RecorderContext.Provider>
  )
}

/** Surfaces a start-up failure once, then clears it so it cannot repeat. */
function ErrorToast({ engine }: { engine: ReturnType<typeof useRecorderEngine> }) {
  const toast = useToast()
  const shown = useRef(false)
  if (!shown.current) {
    shown.current = true
    toast.error(engine.error ?? 'The recording failed.')
    // Deferred so the reset does not run during render.
    setTimeout(() => engine.reset(), 0)
  }
  return null
}
