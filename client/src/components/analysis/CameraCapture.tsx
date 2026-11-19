import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Circle, Loader2, Square, Video } from 'lucide-react'
import { VBT_LIFTS, type VbtLift } from 'coachboard-shared/vbt'
import { Button } from '../ui/button'
import { getList } from '../../lib/api'
import { rememberedLift } from './VelocityPanel'
import {
  CAMERA_BITS_PER_SECOND,
  MAX_RECORDING_MS,
  cameraMimeType,
  finishRecording,
  formatElapsed,
  recordingFileName,
} from './cameraRecording'

// ---------------------------------------------------------------------------
// Record a set from a camera, for coaching in person (BP41, D100–D103).
//
// Any camera the computer sees: a webcam, or a phone used as one through Phone
// Link, Camo, DroidCam or Continuity Camera. Record / Stop (or Space); after
// Stop the clip opens for analysis as if it had been dropped in, with the
// athlete and lift picked here. Nothing is kept unless the analysis is saved.
// ---------------------------------------------------------------------------

export interface CameraTake {
  file: File
  athleteId: string | null
  lift: VbtLift
}

const CAMERA_KEY = 'coachboard-camera-device'
const readCamera = (): string | null => { try { return localStorage.getItem(CAMERA_KEY) } catch { return null } }
const keepCamera = (id: string) => { try { localStorage.setItem(CAMERA_KEY, id) } catch { /* not worth failing over */ } }

type Status = 'starting' | 'ready' | 'recording' | 'finishing' | 'error'

/** Keys typed into a field, or pressed on a button, are theirs — not the recorder's. */
const ownsSpace = (el: EventTarget | null): boolean =>
  el instanceof HTMLElement && !!el.closest('input, textarea, select, button, [role="combobox"], [contenteditable="true"]')

export default function CameraCapture({ onDone, onCancel }: { onDone: (take: CameraTake) => void; onCancel: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  /** Set when leaving mid-recording: the stop that follows must not open the clip. */
  const discard = useRef(false)
  const startedAt = useRef(0)
  const [status, setStatus] = useState<Status>('starting')
  const [error, setError] = useState<string | null>(null)
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])
  /** The camera asked for (null: any); `activeId` is the one that actually opened. */
  const [deviceId, setDeviceId] = useState<string | null>(readCamera())
  const [activeId, setActiveId] = useState<string>('')
  const [settings, setSettings] = useState<{ width?: number; height?: number; frameRate?: number } | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [athletes, setAthletes] = useState<{ id: string; name: string }[]>([])
  const [athleteId, setAthleteId] = useState<string>('')
  const [lift, setLift] = useState<VbtLift>(rememberedLift())
  const [attempt, setAttempt] = useState(0)

  useEffect(() => { getList<{ id: string; name: string }>('/api/athletes').then(setAthletes, () => setAthletes([])) }, [])

  const release = useCallback(() => {
    for (const t of streamRef.current?.getTracks() ?? []) t.stop()
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  // The chosen camera, as sharp and as fast as it will go: tracking reads every
  // frame, so 60 a second beats 30 when the camera has it.
  useEffect(() => {
    let cancelled = false
    setStatus('starting')
    setError(null)
    release()
    const video: MediaTrackConstraints = {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 60 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    }
    navigator.mediaDevices
      .getUserMedia({ video, audio: false })
      .then(async (stream) => {
        if (cancelled) { for (const t of stream.getTracks()) t.stop(); return }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          const v = videoRef.current
          Promise.resolve().then(() => v.play()).catch(() => { /* autoplay refused: the preview stays black, recording still works */ })
        }
        const track = stream.getVideoTracks()[0]
        const s = track?.getSettings() ?? {}
        setSettings({ width: s.width, height: s.height, frameRate: s.frameRate })
        // Labels are only given once the camera has been allowed, so the list is read now.
        const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
        if (cancelled) return
        setCameras(all)
        setActiveId(s.deviceId ?? '')
        setStatus('ready')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const name = (err as { name?: string } | null)?.name
        // A remembered camera that has since been unplugged: fall back to any.
        if (deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) { setDeviceId(null); return }
        setStatus('error')
        setError(
          name === 'NotAllowedError'
            ? 'CoachBoard was not allowed to use the camera. Allow it in Windows Settings → Privacy & security → Camera, then try again.'
            : name === 'NotReadableError'
              ? 'The camera is in use by another app. Close that app (a video call, the Camera app), then try again.'
              : 'No camera found. Plug in a webcam, or connect your phone as a webcam (Phone Link, Camo or DroidCam), then try again.',
        )
      })
    return () => { cancelled = true }
  }, [deviceId, attempt, release])

  // Released when leaving, so the camera light goes off.
  useEffect(() => () => {
    discard.current = true
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    release()
  }, [release])

  const start = () => {
    const stream = streamRef.current
    if (!stream || status !== 'ready') return
    const mimeType = cameraMimeType()
    const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: CAMERA_BITS_PER_SECOND })
    const parts: Blob[] = []
    recorder.ondataavailable = (e) => { if (e.data.size) parts.push(e.data) }
    recorder.onstop = async () => {
      if (discard.current) return
      setStatus('finishing')
      const file = await finishRecording(new Blob(parts, { type: 'video/webm' }), recordingFileName())
      release()
      onDone({ file, athleteId: athleteId || null, lift })
    }
    recorderRef.current = recorder
    startedAt.current = Date.now()
    setElapsed(0)
    recorder.start(1000)
    setStatus('recording')
  }

  const stop = useCallback(() => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }, [])

  // The clock, and the safety stop.
  useEffect(() => {
    if (status !== 'recording') return
    const timer = window.setInterval(() => {
      const ms = Date.now() - startedAt.current
      setElapsed(ms)
      if (ms >= MAX_RECORDING_MS) stop()
    }, 250)
    return () => window.clearInterval(timer)
  }, [status, stop])

  // Space starts and stops (D101), unless the cursor is in a field or on a button.
  const toggleRef = useRef<() => void>(() => {})
  toggleRef.current = () => (status === 'recording' ? stop() : start())
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== ' ' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || ownsSpace(e.target)) return
      if (document.querySelector('[role="dialog"], [role="menu"]')) return
      e.preventDefault()
      toggleRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const recording = status === 'recording'
  const camLabel = (d: MediaDeviceInfo, i: number) => d.label || `Camera ${i + 1}`

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => { discard.current = true; stop(); release(); onCancel() }} disabled={status === 'finishing'}>
          <ArrowLeft className="h-4 w-4" />Back
        </Button>
        <h2 className="flex items-center gap-2 text-base font-semibold"><Video className="h-4 w-4 text-primary" />Record a set</h2>
      </div>

      <div className="flex flex-wrap items-end gap-3 text-sm">
        {cameras.length > 1 && (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Camera</span>
            <select
              value={activeId}
              onChange={(e) => { keepCamera(e.target.value); setDeviceId(e.target.value) }}
              disabled={recording || status === 'finishing'}
              className="max-w-[16rem] rounded-md border bg-background px-2 py-1 text-sm"
            >
              {cameras.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{camLabel(d, i)}</option>)}
            </select>
          </label>
        )}
        {/* D103: picked now, carried over, so saving afterwards is one click. */}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Athlete (optional)</span>
          <select value={athleteId} onChange={(e) => setAthleteId(e.target.value)} className="max-w-[14rem] rounded-md border bg-background px-2 py-1 text-sm">
            <option value="">Choose later</option>
            {athletes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Lift</span>
          <select value={lift} onChange={(e) => setLift(e.target.value as VbtLift)} className="rounded-md border bg-background px-2 py-1 text-sm">
            {VBT_LIFTS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </label>
      </div>

      <div className="relative overflow-hidden rounded-lg border bg-black">
        <video ref={videoRef} muted playsInline aria-label="Camera preview" className="mx-auto max-h-[60vh] w-full object-contain" />
        {status === 'starting' && <p className="absolute inset-0 flex items-center justify-center text-sm text-white/80">Starting the camera…</p>}
        {recording && (
          <span className="num absolute left-3 top-3 flex items-center gap-1.5 rounded bg-black/70 px-2 py-1 text-sm font-medium text-white">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-destructive motion-reduce:animate-none" />{formatElapsed(elapsed)}
          </span>
        )}
        {status === 'finishing' && (
          <p className="absolute inset-0 flex items-center justify-center gap-2 bg-black/50 text-sm text-white">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />Preparing the clip…
          </p>
        )}
      </div>

      {error ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span role="alert" className="text-destructive">{error}</span>
          <Button size="sm" variant="outline" onClick={() => { setDeviceId(null); setAttempt((n) => n + 1) }}>Try again</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={recording ? stop : start}
            disabled={status !== 'ready' && !recording}
            variant={recording ? 'destructive' : 'default'}
            className="min-w-[8rem]"
          >
            {recording ? <><Square className="h-4 w-4" />Stop</> : <><Circle className="h-4 w-4 fill-current" />Record</>}
          </Button>
          <span className="text-xs text-muted-foreground">
            Space starts and stops.
            {settings?.width && settings.height ? ` ${settings.width} × ${settings.height}` : ''}
            {settings?.frameRate ? ` · ${Math.round(settings.frameRate)} frames a second` : ''}
          </span>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Film from the side, with the whole plate in view and the camera held still. Nothing is kept
        unless you save the analysis.
      </p>
    </div>
  )
}
