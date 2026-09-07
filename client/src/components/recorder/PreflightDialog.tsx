import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, CameraOff, Mic, MicOff, Monitor, Volume2, VolumeX } from 'lucide-react'
import { Button } from '../ui/button'
import type { RecorderOptions } from './useRecorderEngine'

// ---------------------------------------------------------------------------
// The "check yourself before you go live" step, in the shape people already
// know from Teams and Zoom: pick what to record, see your own camera, watch the
// level meter move when you speak, then start.
//
// The preview deliberately uses the SAME getUserMedia constraints the recording
// will, so a camera that is busy or a microphone that is muted fails here —
// where it costs nothing — rather than after a five-minute take.
// ---------------------------------------------------------------------------

export interface CaptureSource {
  id: string
  name: string
  kind: 'screen' | 'window' | 'self'
  thumbnailDataUrl: string | null
}

interface Props {
  onStart(options: RecorderOptions): void
  onCancel(): void
}

export default function PreflightDialog({ onStart, onCancel }: Props) {
  const [sources, setSources] = useState<CaptureSource[] | null>(null)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [camera, setCamera] = useState(true)
  const [microphone, setMicrophone] = useState(true)
  const [systemAudio, setSystemAudio] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [level, setLevel] = useState(0)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const previewRef = useRef<MediaStream | null>(null)
  const micRef = useRef<MediaStream | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    fetch('/api/recorder/sources')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('Could not list sources'))))
      .then((list: CaptureSource[]) => {
        setSources(list)
        // CoachBoard is first and is the common case, so it is preselected.
        setSourceId(list[0]?.id ?? null)
      })
      .catch(() => setSources([]))
  }, [])

  const stopPreview = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    for (const stream of [previewRef.current, micRef.current]) {
      for (const track of stream?.getTracks() ?? []) track.stop()
    }
    previewRef.current = null
    micRef.current = null
    void audioCtxRef.current?.close().catch(() => {})
    audioCtxRef.current = null
    setLevel(0)
  }, [])

  // Camera preview follows the toggle, so turning it off releases the device
  // rather than leaving the indicator light on.
  useEffect(() => {
    let cancelled = false
    if (!camera) {
      for (const track of previewRef.current?.getTracks() ?? []) track.stop()
      previewRef.current = null
      if (videoRef.current) videoRef.current.srcObject = null
      return
    }
    navigator.mediaDevices
      .getUserMedia({ video: { width: 640, height: 480 } })
      .then((stream) => {
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop()
          return
        }
        previewRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
      })
      .catch(() => setError('No camera available. You can still record without it.'))
    return () => {
      cancelled = true
    }
  }, [camera])

  // Level meter. Reads the microphone the recording will actually use, because
  // "is this thing on" is the question the preflight exists to answer.
  useEffect(() => {
    let cancelled = false
    if (!microphone) {
      for (const track of micRef.current?.getTracks() ?? []) track.stop()
      micRef.current = null
      setLevel(0)
      return
    }
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop()
          return
        }
        micRef.current = stream
        const ctx = new AudioContext()
        audioCtxRef.current = ctx
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        ctx.createMediaStreamSource(stream).connect(analyser)
        const buffer = new Uint8Array(analyser.frequencyBinCount)
        const tick = () => {
          analyser.getByteTimeDomainData(buffer)
          // RMS around the 128 midpoint, scaled so ordinary speech fills most
          // of the bar without clipping it.
          let sum = 0
          for (const sample of buffer) sum += (sample - 128) ** 2
          const rms = Math.sqrt(sum / buffer.length) / 128
          setLevel(Math.min(1, rms * 3))
          rafRef.current = requestAnimationFrame(tick)
        }
        rafRef.current = requestAnimationFrame(tick)
      })
      .catch(() => setError('No microphone available. The recording will be silent.'))
    return () => {
      cancelled = true
    }
  }, [microphone])

  useEffect(() => stopPreview, [stopPreview])

  const begin = () => {
    if (!sourceId) return
    stopPreview()
    onStart({ sourceId, camera, microphone, systemAudio })
  }

  const cancel = () => {
    stopPreview()
    onCancel()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-border bg-card p-6 shadow-lg">
        <h2 className="text-lg font-semibold">Record a video</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Talk an athlete through a program, or over a bar path. Nothing is kept unless you save
          or send it.
        </p>

        <h3 className="mt-5 text-sm font-medium">What should be recorded?</h3>
        {sources === null ? (
          <p className="mt-2 text-sm text-muted-foreground">Looking for windows…</p>
        ) : sources.length === 0 ? (
          <p className="mt-2 text-sm text-destructive">
            Screen recording is only available in the desktop app.
          </p>
        ) : (
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {sources.map((source) => (
              <button
                key={source.id}
                onClick={() => setSourceId(source.id)}
                className={`rounded-md border p-2 text-left transition-colors ${
                  sourceId === source.id
                    ? 'border-primary bg-accent'
                    : 'border-input hover:bg-accent'
                }`}
              >
                {source.thumbnailDataUrl ? (
                  // object-contain, not cover: cropping a window thumbnail to
                  // fill the box would misrepresent what is about to be
                  // recorded. The letterbox is the honest rendering.
                  <img
                    src={source.thumbnailDataUrl}
                    alt=""
                    loading="lazy"
                    className="mb-2 aspect-video w-full rounded bg-black object-contain"
                  />
                ) : (
                  <div className="mb-2 flex aspect-video w-full items-center justify-center rounded bg-muted">
                    <Monitor className="h-6 w-6 text-muted-foreground" />
                  </div>
                )}
                <div className="truncate text-xs" title={source.name}>
                  {source.name}
                </div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {source.kind === 'self' ? 'this app' : source.kind}
                </div>
              </button>
            ))}
          </div>
        )}

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="text-sm font-medium">You</h3>
            <div className="mt-2 aspect-video w-full overflow-hidden rounded-md bg-black">
              {camera ? (
                <video
                  ref={videoRef}
                  autoPlay
                  muted
                  playsInline
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  Camera off
                </div>
              )}
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-medium">Sound</h3>

            <Toggle
              on={camera}
              onChange={setCamera}
              onIcon={<Camera className="h-4 w-4" />}
              offIcon={<CameraOff className="h-4 w-4" />}
              label="Camera"
            />
            <Toggle
              on={microphone}
              onChange={setMicrophone}
              onIcon={<Mic className="h-4 w-4" />}
              offIcon={<MicOff className="h-4 w-4" />}
              label="Microphone"
            />
            <Toggle
              on={systemAudio}
              onChange={setSystemAudio}
              onIcon={<Volume2 className="h-4 w-4" />}
              offIcon={<VolumeX className="h-4 w-4" />}
              label="Sound from this computer"
            />

            <div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-75"
                  style={{ width: `${Math.round(level * 100)}%` }}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {microphone ? 'Say something — the bar should move.' : 'Microphone is off.'}
              </p>
            </div>
          </div>
        </div>

        {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button onClick={begin} disabled={!sourceId}>
            Start recording
          </Button>
        </div>
      </div>
    </div>
  )
}

function Toggle({
  on,
  onChange,
  onIcon,
  offIcon,
  label,
}: {
  on: boolean
  onChange(next: boolean): void
  onIcon: React.ReactNode
  offIcon: React.ReactNode
  label: string
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
        on ? 'border-primary bg-accent' : 'border-input text-muted-foreground hover:bg-accent'
      }`}
    >
      {on ? onIcon : offIcon}
      <span>{label}</span>
      <span className="ml-auto text-xs">{on ? 'On' : 'Off'}</span>
    </button>
  )
}
