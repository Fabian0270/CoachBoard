import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { useToast } from '../ui/toast'
import PreflightDialog from './PreflightDialog'
import RecordingPill from './RecordingPill'
import ReviewDialog from './ReviewDialog'
import { isCapturing } from './recorder.core'
import { useRecorderEngine, type RecorderOptions } from './useRecorderEngine'

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

  const onStart = useCallback(
    (options: RecorderOptions) => {
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

      {isCapturing(engine.state) && (
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
          onSaved={onSaved}
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
