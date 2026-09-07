import { useCallback, useEffect, useRef, useState } from 'react'
import { PoseLandmarker } from '@mediapipe/tasks-vision'
import PoseSpikeWorker from './pose.spike.worker?worker'
import type { SpikeModel } from './pose.spike.worker'
import { Button } from '../components/ui/button'

// ---------------------------------------------------------------------------
// Feature 11e-0 — the pose spike, as a page inside the real app.
//
// It has to run here rather than in a standalone benchmark because three of the
// five things it measures are properties of THIS app, not of MediaPipe: whether
// the vendored fileset loads under our CSP, whether the worker format Vite emits
// matches the WASM loader, and what the packaged build does differently from
// dev. A number produced anywhere else would not transfer.
//
// Delete this directory once the GO/NO-GO is recorded.
// ---------------------------------------------------------------------------

/**
 * The matrix. Two models at two input widths, single-threaded.
 *
 * Already run against two real clips (see ROADMAP 11e-0): `lite` at ~32 ms a
 * frame fits the budget and `full` at ~46 ms does not, with identical detection
 * on both. Width barely matters — MediaPipe resizes to its own tensor size, so
 * 256 and 384 land within 2 ms of each other.
 *
 * Kept as a matrix rather than trimmed to the winner because the open item is a
 * run from a PACKAGED build, where the vendored path, the CSP and the worker
 * format all behave differently and CI sees none of it.
 */
const MODELS: SpikeModel[] = ['lite', 'full']
const WIDTHS = [256, 384]

/** The frame budget pose has to fit inside to ride along with tracking for free. */
const FRAME_BUDGET_MS = 33

interface Run {
  model: SpikeModel
  width: number
  loadMs: number
  frames: number
  /** Frames where a person was found at all. A low number invalidates the timings. */
  detected: number
  median: number
  p95: number
  worst: number
  /** Whole-clip wall clock, so a run can be checked against the video's duration. */
  totalMs: number
}

const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0

export default function PoseSpike() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const abortRef = useRef(false)

  const [url, setUrl] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [runs, setRuns] = useState<Run[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [useModule, setUseModule] = useState<boolean | null>(null)

  useEffect(() => {
    if (!url) return
    return () => URL.revokeObjectURL(url)
  }, [url])

  /**
   * One pass of the clip at one model and width.
   *
   * Frames are pulled the way captureFrames does it — real muted playback at 1x
   * off requestVideoFrameCallback — because that is the pipeline pose would
   * actually join, and because seeking was measured at 30-150 ms/frame during
   * the 11b spike. The video element is drawn to a canvas rather than handed to
   * createImageBitmap: the bitmap path applies its resize BEFORE the clip's
   * rotation metadata, which turned a 480x640 portrait into 427x320 of sideways
   * content last time and would quietly wreck every landmark here.
   */
  const runOne = useCallback(async (model: SpikeModel, width: number): Promise<Run> => {
    const video = videoRef.current
    if (!video || !video.videoWidth) throw new Error('No decoded video')

    const worker = new PoseSpikeWorker()
    const height = Math.round((width / video.videoWidth) * video.videoHeight)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!

    const preview = canvasRef.current
    const pctx = preview?.getContext('2d') ?? null

    const times: number[] = []
    let detected = 0
    let loadMs = 0
    let pending: ((value: void) => void) | null = null
    let failure: string | null = null

    worker.onmessage = (e: MessageEvent) => {
      const m = e.data
      if (m.type === 'ready') {
        loadMs = m.loadMs
        setUseModule(m.useModule)
      } else if (m.type === 'result') {
        times.push(m.inferMs)
        if (m.landmarks) detected++
        if (pctx && preview) drawSkeleton(pctx, preview, m.landmarks)
      } else if (m.type === 'error') {
        failure = m.message
      }
      pending?.()
      pending = null
    }
    const settled = () => new Promise<void>((resolve) => (pending = resolve))

    worker.postMessage({ type: 'init', model })
    await settled()
    if (failure) {
      worker.terminate()
      throw new Error(failure)
    }

    video.currentTime = 0
    video.muted = true
    await video.play()

    const startedAt = performance.now()
    await new Promise<void>((resolve) => {
      const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
        if (abortRef.current || video.ended || failure) {
          resolve()
          return
        }
        ctx.drawImage(video, 0, 0, width, height)
        const data = ctx.getImageData(0, 0, width, height).data
        // Transferred, not copied. Buffering these was ~330 MB for a
        // twenty-second clip when 11a tried it.
        worker.postMessage(
          { type: 'frame', t: meta.mediaTime, width, height, data: data.buffer },
          [data.buffer],
        )
        settled().then(() => video.requestVideoFrameCallback(onFrame))
      }
      video.requestVideoFrameCallback(onFrame)
      video.onended = () => resolve()
    })
    const totalMs = performance.now() - startedAt

    video.pause()
    worker.postMessage({ type: 'close' })
    worker.terminate()
    if (failure) throw new Error(failure)

    const sorted = [...times].sort((a, b) => a - b)
    return {
      model,
      width,
      loadMs,
      frames: times.length,
      detected,
      median: pct(sorted, 0.5),
      p95: pct(sorted, 0.95),
      worst: sorted[sorted.length - 1] ?? 0,
      totalMs,
    }
  }, [])

  const runAll = async () => {
    setRuns([])
    setError(null)
    abortRef.current = false
    try {
      for (const model of MODELS) {
        for (const width of WIDTHS) {
          setBusy(`${model} @ ${width}px`)
          const run = await runOne(model, width)
          setRuns((prev) => [...prev, run])
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">Pose spike — Feature 11e-0</h1>
        <p className="text-sm text-muted-foreground">
          Measures MediaPipe pose inference inside this app, single-threaded, on a real clip. The
          number that matters is the median against the {FRAME_BUDGET_MS} ms frame budget: under it,
          pose rides along with bar-path tracking for free.
        </p>
      </div>

      <input
        type="file"
        accept="video/*"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (!file) return
          setName(file.name)
          setUrl(URL.createObjectURL(file))
          setRuns([])
        }}
        className="text-sm"
      />

      {url && (
        <div className="flex flex-wrap gap-4">
          <video
            ref={videoRef}
            src={url}
            muted
            playsInline
            className="max-h-[40vh] w-auto rounded-md border"
          />
          {/* The skeleton as it is found, so "does it sit on the lifter through
              the occluded squat" is answered by eye while the timings run. */}
          <canvas ref={canvasRef} width={384} height={384} className="rounded-md border bg-black" />
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={runAll} disabled={!url || busy !== null}>
          {busy ? `Running ${busy}…` : 'Run the matrix'}
        </Button>
        {busy && (
          <Button variant="outline" onClick={() => (abortRef.current = true)}>
            Stop
          </Button>
        )}
        {useModule !== null && (
          <span className="text-xs text-muted-foreground">
            worker: {useModule ? 'ES module' : 'classic'} · fileset loaded from vendor
          </span>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-destructive/50 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {runs.length > 0 && (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Model</th>
                <th className="px-3 py-2">Input</th>
                <th className="px-3 py-2">Median</th>
                <th className="px-3 py-2">p95</th>
                <th className="px-3 py-2">Worst</th>
                <th className="px-3 py-2">Frames</th>
                <th className="px-3 py-2">Found</th>
                <th className="px-3 py-2">Load</th>
                <th className="px-3 py-2">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={`${r.model}-${r.width}`} className="border-t">
                  <td className="px-3 py-2 font-medium">{r.model}</td>
                  <td className="px-3 py-2">{r.width}px</td>
                  <td className="px-3 py-2 font-medium">{r.median.toFixed(1)} ms</td>
                  <td className="px-3 py-2">{r.p95.toFixed(1)} ms</td>
                  <td className="px-3 py-2">{r.worst.toFixed(1)} ms</td>
                  <td className="px-3 py-2">{r.frames}</td>
                  {/* A fast run that found nobody is not a fast run. */}
                  <td className="px-3 py-2">
                    {r.frames ? Math.round((r.detected / r.frames) * 100) : 0}%
                  </td>
                  <td className="px-3 py-2">{(r.loadMs / 1000).toFixed(1)} s</td>
                  <td className="px-3 py-2">
                    {r.median <= FRAME_BUDGET_MS ? (
                      <span className="text-emerald-600">fits</span>
                    ) : (
                      <span className="text-destructive">over budget</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {runs.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Clip: {name}. Run this again from a packaged build before trusting it — vendored assets,
          CSP and worker formats all behave differently there, and CI sees none of it.
        </p>
      )}
    </div>
  )
}

/** Landmarks are normalised 0-1 against the input image, so the preview scales them itself. */
function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  landmarks: { x: number; y: number; visibility: number }[] | null,
) {
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  if (!landmarks) return

  const px = (l: { x: number; y: number }) => [l.x * canvas.width, l.y * canvas.height] as const

  ctx.lineWidth = 2
  for (const { start, end } of PoseLandmarker.POSE_CONNECTIONS) {
    const a = landmarks[start]
    const b = landmarks[end]
    if (!a || !b) continue
    // Greyed rather than hidden when the model cannot see the joint — a loaded
    // bar occludes the hip from side on, and a confident wrong bone is worse
    // than a visibly uncertain one.
    const faint = Math.min(a.visibility, b.visibility) < 0.5
    ctx.strokeStyle = faint ? '#52525b' : '#22d3ee'
    ctx.beginPath()
    ctx.moveTo(...px(a))
    ctx.lineTo(...px(b))
    ctx.stroke()
  }

  for (const l of landmarks) {
    ctx.fillStyle = l.visibility < 0.5 ? '#52525b' : '#f4f4f5'
    ctx.beginPath()
    ctx.arc(...px(l), 2.5, 0, Math.PI * 2)
    ctx.fill()
  }
}
