import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, FileVideo, X } from 'lucide-react'
import type { VideoAnalysisDto } from 'coachboard-shared/videoAnalysis'
import { pixelsPerMetreFromPlate } from 'coachboard-shared/videoAnalysis'
import {
  defaultMvt,
  defaultVelocityMetric,
  e1RMFromVelocity,
  isVbtLift,
  isVelocityMetric,
  lastRepVelocity,
  liftLabel,
  populationSlope,
  readRep,
  type VbtLift,
} from 'coachboard-shared/vbt'
import { Button } from '../components/ui/button'
import AnalysisStage, { type StageMode } from '../components/analysis/AnalysisStage'
import DrawControls from '../components/analysis/DrawControls'
import PathPlot from '../components/analysis/PathPlot'
import type { Stroke } from '../components/analysis/annotations'
import { useTrackerColor } from '../components/analysis/trackerColor'

// ---------------------------------------------------------------------------
// Two lifts, side by side.
//
// "This rep versus that rep" is a core coaching question the app could not
// answer. Each side is independent on purpose — separate controls, separate
// scrubbing — because the two clips almost never start at the same point in the
// lift, and a shared scrubber would force the coach to fight the sync instead of
// lining the lifts up by eye.
//
// A side can be a saved analysis (video + path + numbers) or a clip straight
// off disk (video only). The second is deliberately allowed: a coach comparing
// two attempts filmed this morning should not have to analyse both first.
// ---------------------------------------------------------------------------

/** One half of the comparison. */
type Side =
  | { kind: 'empty' }
  | { kind: 'saved'; analysis: VideoAnalysisDto }
  | { kind: 'local'; name: string; url: string }

export default function CompareAnalyses() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [color] = useTrackerColor()
  const [saved, setSaved] = useState<VideoAnalysisDto[] | null>(null)
  const [left, setLeft] = useState<Side>({ kind: 'empty' })
  const [right, setRight] = useState<Side>({ kind: 'empty' })

  // The list is fetched without tracks — the paths are only needed once a side
  // actually picks one, and a whole history of them is megabytes.
  useEffect(() => {
    fetch('/api/analysis?withTrack=0')
      .then((r) => (r.ok ? r.json() : []))
      .then(setSaved)
      .catch(() => setSaved([]))
  }, [])

  // Deep link from the saved list: /analysis/compare?left=<id>
  useEffect(() => {
    const wanted = [params.get('left'), params.get('right')] as const
    wanted.forEach((id, i) => {
      if (!id) return
      fetch(`/api/analysis/${id}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((a: VideoAnalysisDto | null) => {
          if (!a) return
          ;(i === 0 ? setLeft : setRight)({ kind: 'saved', analysis: a })
        })
        .catch(() => {})
    })
  }, [params])

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate('/analysis')} title="Back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-xl font-semibold">Compare two lifts</h1>
      </div>
      <p className="text-sm text-muted-foreground">
        Each side plays on its own, so you can line the two lifts up by eye. Double-click either one
        for fullscreen, or use the button in its controls — the bar path and anything you draw stay
        on the lift either way.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        <Pane side={left} onChange={setLeft} saved={saved} color={color} label="Left" />
        <Pane side={right} onChange={setRight} saved={saved} color={color} label="Right" />
      </div>

      {left.kind === 'saved' && right.kind === 'saved' && (
        <Numbers a={left.analysis} b={right.analysis} />
      )}
    </div>
  )
}

function Pane({
  side,
  onChange,
  saved,
  color,
  label,
}: {
  side: Side
  onChange: (next: Side) => void
  saved: VideoAnalysisDto[] | null
  color: string
  label: string
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const emptyLivePath = useRef<never[]>([])
  // Per side, not per page: the two lifts are being contrasted, so a mark drawn
  // on one is about that one. Held here for the same reason the tracking page
  // holds them — they belong to the moment of explanation, not to the analysis.
  const [mode, setMode] = useState<StageMode>('seed')
  const [strokes, setStrokes] = useState<Stroke[]>([])

  // Revoked on swap and unmount, or the bytes stay pinned for the life of the
  // window — the same discipline as the re-pick input on SavedAnalysis.
  useEffect(() => {
    const url = side.kind === 'local' ? side.url : null
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [side])

  // Marks belong to the clip they were drawn on, so swapping either side out
  // clears them rather than leaving last lift's circles over this one.
  useEffect(() => {
    setStrokes([])
    setMode('seed')
  }, [side])

  if (side.kind === 'empty') {
    return (
      <div className="space-y-3 rounded-md border border-dashed p-4">
        <h2 className="text-sm font-medium">{label}</h2>
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <FileVideo className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">Pick a clip from your computer</span>
          <input
            type="file"
            accept="video/*"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) {
                onChange({ kind: 'local', name: file.name, url: URL.createObjectURL(file) })
              }
            }}
            className="text-xs file:mr-2 file:rounded-md file:border file:bg-background file:px-2 file:py-1 file:text-xs"
          />
        </label>
        <div>
          <p className="mb-1 text-xs text-muted-foreground">…or a saved analysis</p>
          <select
            value=""
            onChange={(e) => {
              const found = saved?.find((a) => a.id === e.target.value)
              if (!found) return
              // The list came back without tracks, so the full row is fetched
              // here — the path is the whole point of picking a saved one.
              fetch(`/api/analysis/${found.id}`)
                .then((r) => (r.ok ? r.json() : null))
                .then((a: VideoAnalysisDto | null) => a && onChange({ kind: 'saved', analysis: a }))
                .catch(() => {})
            }}
            className="w-full rounded-md border bg-background px-2 py-1 text-sm"
          >
            <option value="">Choose a saved analysis…</option>
            {(saved ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {describe(a)}
              </option>
            ))}
          </select>
        </div>
      </div>
    )
  }

  const title = side.kind === 'saved' ? describe(side.analysis) : side.name
  const analysis = side.kind === 'saved' ? side.analysis : null
  const src =
    side.kind === 'local'
      ? side.url
      : analysis!.hasVideo
        ? `/api/analysis/${analysis!.id}/video`
        : null

  const pixelsPerMetre =
    analysis?.calibration != null
      ? pixelsPerMetreFromPlate(
          Math.hypot(
            analysis.calibration.b.x - analysis.calibration.a.x,
            analysis.calibration.b.y - analysis.calibration.a.y,
          ),
          analysis.calibration.plateDiameterMm,
        )
      : null

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="truncate text-sm font-medium" title={title}>
          {title}
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          {/* The same pen as the tracking page, on each side independently —
              comparing two lifts is exactly when a coach wants to circle the
              difference. Only where there is a video to draw on. */}
          {src && (
            <DrawControls
              mode={mode}
              onModeChange={setMode}
              strokes={strokes}
              onStrokesChange={setStrokes}
              compact
            />
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange({ kind: 'empty' })}
            title="Clear"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {src ? (
        <AnalysisStage
          src={src}
          videoRef={videoRef}
          seed={null}
          samples={analysis?.track ?? null}
          livePathRef={emptyLivePath}
          onPlaceSeed={() => {}}
          onLoadedMetadata={() => {}}
          onTimeUpdate={() => {}}
          disabled
          color={color}
          mode={mode}
          calibration={analysis?.calibration ?? null}
          onCalibratePoint={() => {}}
          strokes={strokes}
          onDrawStroke={(s) => setStrokes((prev) => [...prev, s])}
        />
      ) : analysis ? (
        <PathPlot track={analysis.track} color={color} pixelsPerMetre={pixelsPerMetre} />
      ) : null}

      {side.kind === 'local' && (
        // Said plainly rather than showing an empty overlay: a clip off disk has
        // no bar path until it is tracked, and silence here would look like a
        // tracking failure.
        <p className="text-xs text-muted-foreground">
          No bar path — this clip has not been analysed. Track it on the Bar path page to get one.
        </p>
      )}
    </div>
  )
}

/** The numbers worth putting beside each other, only where both sides have them. */
function Numbers({ a, b }: { a: VideoAnalysisDto; b: VideoAnalysisDto }) {
  const rows = useMemo(() => {
    const read = (x: VideoAnalysisDto) => {
      const lift: VbtLift = isVbtLift(x.lift) ? x.lift : 'back-squat'
      const metric = isVelocityMetric(x.metric) ? x.metric : defaultVelocityMetric(lift)
      const best = x.metrics.length
        ? Math.max(...x.metrics.map((m) => readRep(m, metric) ?? 0))
        : 0
      const mvt = defaultMvt(lift)
      const estimate =
        x.loadKg != null && best > 0 && mvt != null
          ? e1RMFromVelocity({
              loadKg: x.loadKg,
              velocity: best,
              mvt,
              slope: populationSlope(lift),
            })
          : null
      return {
        lift: liftLabel(lift),
        load: x.loadKg != null ? `${x.loadKg} kg` : '—',
        reps: String(x.metrics.length),
        last: fmt(lastRepVelocity(x.metrics, metric)),
        best: best > 0 ? `${best.toFixed(2)} m/s` : '—',
        e1rm: estimate ? `${Math.round(estimate.e1rm)} kg` : '—',
      }
    }
    const [ra, rb] = [read(a), read(b)]
    return [
      ['Lift', ra.lift, rb.lift],
      ['Load', ra.load, rb.load],
      ['Reps', ra.reps, rb.reps],
      ['Last rep', ra.last, rb.last],
      ['Best rep', ra.best, rb.best],
      ['Estimated 1RM', ra.e1rm, rb.e1rm],
    ] as const
  }, [a, b])

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[28rem] text-sm">
        <tbody>
          {rows.map(([label, left, right]) => (
            <tr key={label} className="border-b last:border-0">
              <td className="px-3 py-2 text-muted-foreground">{label}</td>
              <td className="px-3 py-2 font-medium">{left}</td>
              <td className="px-3 py-2 font-medium">{right}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const fmt = (v: number | null) => (v == null ? '—' : `${v.toFixed(2)} m/s`)

function describe(a: VideoAnalysisDto): string {
  const lift = isVbtLift(a.lift) ? liftLabel(a.lift) : a.sourceLabel
  const load = a.loadKg != null ? ` ${a.loadKg} kg` : ''
  const who = a.athleteName ? ` — ${a.athleteName}` : ''
  return `${lift}${load}${who} · ${a.createdAt.slice(0, 10)}`
}
