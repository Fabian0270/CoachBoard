import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { createCompositor, type Compositor } from '../components/recorder/compositor'
import {
  formatBytes,
  formatDuration,
  planEncoding,
  sizeStatus,
  budgetMs,
  DISCORD_MAX_BYTES,
  type EncodingPlan,
} from '../components/recorder/recorder.core'

// ---------------------------------------------------------------------------
// TEMPORARY — Feature 11c spike (phase 11c-0).
//
// Not linked from the sidebar; reachable only at #/recorder-spike. It exists to
// answer, by measurement rather than by reading docs, the questions that decide
// how 11c gets built:
//
//   1. Does Electron 33 show Windows 11's own picker, or does our fallback run?
//      (watch for "system picker unavailable" in coachboard.log)
//   2. Does system audio arrive, so a lift video's sound is in the recording?
//   3. Can the compositor hold 30fps for five minutes, and at what cost?
//   4. What does a recording ACTUALLY weigh, versus the estimate?
//   5. Does getUserMedia work in a packaged build?
//   6. Does any of this survive ten minutes without killing the renderer?
//
// Delete this file once the numbers are written into the roadmap.
// ---------------------------------------------------------------------------

interface CaptureSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  thumbnailDataUrl: string | null
}

interface Stats {
  fps: number
  framesDrawn: number
  framesSkipped: number
  elapsedMs: number
  bytes: number
}

const ZERO: Stats = { fps: 0, framesDrawn: 0, framesSkipped: 0, elapsedMs: 0, bytes: 0 }

export default function RecorderSpike() {
  const [wantCamera, setWantCamera] = useState(true)
  const [wantMic, setWantMic] = useState(true)
  const [wantSystemAudio, setWantSystemAudio] = useState(true)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<EncodingPlan | null>(null)
  const [sourceLabel, setSourceLabel] = useState<string>('')
  const [audioTracks, setAudioTracks] = useState<string[]>([])
  const [stats, setStats] = useState<Stats>(ZERO)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [mimeType, setMimeType] = useState<string>('')
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [picking, setPicking] = useState(false)

  const compositorRef = useRef<Compositor | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const bytesRef = useRef(0)
  const startedAtRef = useRef(0)
  const rawStreamsRef = useRef<MediaStream[]>([])
  const tickRef = useRef<number | null>(null)

  const cleanup = useCallback(() => {
    if (tickRef.current !== null) window.clearInterval(tickRef.current)
    tickRef.current = null
    compositorRef.current?.stop()
    compositorRef.current = null
    for (const stream of rawStreamsRef.current) {
      for (const track of stream.getTracks()) track.stop()
    }
    rawStreamsRef.current = []
  }, [])

  useEffect(() => cleanup, [cleanup])

  /** Step one: what does the coach want to record? */
  const openPicker = async () => {
    setError(null)
    setResultUrl(null)
    try {
      const res = await fetch('/api/recorder/sources')
      if (!res.ok) throw new Error((await res.json()).error ?? 'Could not list sources')
      setSources(await res.json())
      setPicking(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const start = async (sourceId: string) => {
    setError(null)
    setPicking(false)
    setResultUrl(null)
    chunksRef.current = []
    bytesRef.current = 0

    try {
      // Parked for the main process to read on the getDisplayMedia call below.
      // Without it the handler refuses rather than guessing at a screen.
      const parked = await fetch('/api/recorder/source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sourceId }),
      })
      if (!parked.ok) throw new Error((await parked.json()).error ?? 'Could not select that source')

      // Requesting audio here is what gives Electron the chance to attach
      // loopback. Chromium ignores the constraint object for display audio, so
      // it is a plain boolean.
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: wantSystemAudio,
      })
      rawStreamsRef.current.push(display)

      const videoTrack = display.getVideoTracks()[0]
      const settings = videoTrack?.getSettings() ?? {}
      setSourceLabel(`${videoTrack?.label ?? 'unknown'} — ${settings.width}x${settings.height}`)

      const nextPlan = planEncoding(settings.width ?? 0, settings.height ?? 0)
      setPlan(nextPlan)

      let webcam: MediaStream | null = null
      if (wantCamera) {
        webcam = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 } })
        rawStreamsRef.current.push(webcam)
      }

      let mic: MediaStream | null = null
      if (wantMic) {
        mic = await navigator.mediaDevices.getUserMedia({ audio: true })
        rawStreamsRef.current.push(mic)
      }

      const compositor = createCompositor({
        display,
        webcam,
        plan: nextPlan,
        corner: 'bottom-right',
      })
      compositorRef.current = compositor

      // Mic and system audio are separate tracks and MediaRecorder takes one,
      // so they are summed in a graph rather than merely both attached.
      const mixed = new MediaStream(compositor.stream.getVideoTracks())
      const audioSources = [mic, display].filter(
        (s): s is MediaStream => !!s && s.getAudioTracks().length > 0,
      )
      setAudioTracks(
        audioSources.flatMap((s) => s.getAudioTracks().map((t) => t.label || '(unlabelled)')),
      )
      if (audioSources.length > 0) {
        const audioCtx = new AudioContext()
        const destination = audioCtx.createMediaStreamDestination()
        for (const source of audioSources) {
          audioCtx.createMediaStreamSource(source).connect(destination)
        }
        for (const track of destination.stream.getAudioTracks()) mixed.addTrack(track)
      }

      const preferred = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      const chosen = preferred.find((t) => MediaRecorder.isTypeSupported(t)) ?? ''
      setMimeType(chosen)

      const recorder = new MediaRecorder(mixed, {
        mimeType: chosen || undefined,
        videoBitsPerSecond: nextPlan.videoBitsPerSecond,
        audioBitsPerSecond: nextPlan.audioBitsPerSecond,
      })
      recorderRef.current = recorder

      recorder.ondataavailable = (e) => {
        if (e.data.size === 0) return
        chunksRef.current.push(e.data)
        bytesRef.current += e.data.size
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: chosen || 'video/webm' })
        setResultUrl(URL.createObjectURL(blob))
        cleanup()
        setRunning(false)
      }

      // The coach stops when they stop talking, so the source of truth for
      // "how big is it so far" has to be the chunks, not an estimate.
      recorder.start(3000)
      startedAtRef.current = performance.now()
      setRunning(true)

      // Ending the capture from the OS ("Stop sharing") must end the recording
      // too, or the file keeps growing against a dead source.
      videoTrack?.addEventListener('ended', () => {
        if (recorder.state !== 'inactive') recorder.stop()
      })

      tickRef.current = window.setInterval(() => {
        const c = compositorRef.current
        const s = c?.stats()
        setStats({
          fps: s?.fps ?? 0,
          framesDrawn: s?.framesDrawn ?? 0,
          framesSkipped: s?.framesSkipped ?? 0,
          elapsedMs: performance.now() - startedAtRef.current,
          bytes: bytesRef.current,
        })
      }, 500)
    } catch (err) {
      setError(err instanceof Error ? `${err.name}: ${err.message}` : String(err))
      cleanup()
      setRunning(false)
    }
  }

  const stop = () => {
    const recorder = recorderRef.current
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    else {
      cleanup()
      setRunning(false)
    }
  }

  const seconds = stats.elapsedMs / 1000
  const measuredBps = seconds > 1 ? (stats.bytes * 8) / seconds : 0
  const status = sizeStatus(stats.bytes)

  return (
    <div className="space-y-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle>Recorder spike (11c-0)</CardTitle>
          <CardDescription>
            Temporary. Measures whether the screen recorder is buildable as planned — picker,
            audio, compositor throughput and real file size. Not linked from the sidebar.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={wantCamera}
                disabled={running}
                onChange={(e) => setWantCamera(e.target.checked)}
              />
              Camera
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={wantMic}
                disabled={running}
                onChange={(e) => setWantMic(e.target.checked)}
              />
              Microphone
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={wantSystemAudio}
                disabled={running}
                onChange={(e) => setWantSystemAudio(e.target.checked)}
              />
              System audio (loopback)
            </label>
          </div>

          <div className="flex gap-2">
            {running ? (
              <Button variant="destructive" onClick={stop}>
                Stop
              </Button>
            ) : (
              <Button onClick={openPicker}>Choose what to record…</Button>
            )}
            {picking && (
              <Button variant="ghost" onClick={() => setPicking(false)}>
                Cancel
              </Button>
            )}
          </div>

          {picking && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {sources.map((source) => (
                <button
                  key={source.id}
                  onClick={() => void start(source.id)}
                  className="rounded-md border border-input p-2 text-left hover:bg-accent"
                >
                  {source.thumbnailDataUrl ? (
                    <img
                      src={source.thumbnailDataUrl}
                      alt=""
                      className="mb-2 aspect-video w-full rounded bg-black object-contain"
                    />
                  ) : (
                    <div className="mb-2 flex aspect-video w-full items-center justify-center rounded bg-muted text-xs text-muted-foreground">
                      minimised
                    </div>
                  )}
                  <div className="truncate text-xs" title={source.name}>
                    {source.name}
                  </div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {source.kind}
                  </div>
                </button>
              ))}
              {sources.length === 0 && (
                <p className="col-span-full text-sm text-muted-foreground">
                  No capture sources came back.
                </p>
              )}
            </div>
          )}

          {error && (
            <p className="text-sm text-destructive">
              {error}
              <br />
              <span className="text-muted-foreground">
                NotAllowedError here means the permission handler refused or the picker was
                dismissed. Check coachboard.log for which path ran.
              </span>
            </p>
          )}

          {plan && (
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
              <Row label="Source" value={sourceLabel} />
              <Row label="Encoding" value={`${plan.width}x${plan.height} @ ${plan.frameRate}`} />
              <Row label="Codec" value={mimeType || '(browser default)'} />
              <Row
                label="Target bitrate"
                value={`${(plan.videoBitsPerSecond / 1_000_000).toFixed(2)} Mbps`}
              />
              <Row label="Audio tracks" value={audioTracks.join(', ') || 'none'} />
              <Row
                label="Discord budget"
                value={formatDuration(budgetMs(DISCORD_MAX_BYTES, plan))}
              />
              <Row label="Compositor fps" value={String(stats.fps)} />
              <Row
                label="Frames drawn / skipped"
                value={`${stats.framesDrawn} / ${stats.framesSkipped}`}
              />
              <Row label="Elapsed" value={formatDuration(stats.elapsedMs)} />
              <Row label="Size so far" value={formatBytes(stats.bytes)} />
              <Row
                label="Measured bitrate"
                value={measuredBps ? `${(measuredBps / 1_000_000).toFixed(2)} Mbps` : '—'}
              />
              <Row
                label="Discord"
                value={status === 'over' ? 'TOO BIG' : status === 'near' ? 'near limit' : 'ok'}
              />
            </dl>
          )}
        </CardContent>
      </Card>

      {resultUrl && (
        <Card>
          <CardHeader>
            <CardTitle>Result</CardTitle>
            <CardDescription>
              Check the webcam bubble is composited over the source, and that you can hear both the
              microphone and the machine's own audio.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <video src={resultUrl} controls className="max-h-[50vh] w-full bg-black" />
            <a
              href={resultUrl}
              download="coachboard-spike.webm"
              className="text-sm text-primary underline"
            >
              Download the file
            </a>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  )
}
