import { Crosshair, Loader2, Palette, PersonStanding, RotateCcw, Ruler, Target } from 'lucide-react'
import { PLATE_DIAMETERS_MM } from 'coachboard-shared/videoAnalysis'
import { Button } from '../ui/button'
import type { StageMode } from './AnalysisStage'
import DrawControls from './DrawControls'
import type { Stroke } from './annotations'
import type { TrackQuality } from './tracker.core'
import { TRACKER_COLORS } from './trackerColor'

// ---------------------------------------------------------------------------
// The controls under the video on the tracking page: what to click next, the
// tracking point's size, the skeleton, the overlay colour, the range, the
// scale, Track / Clear and the pen, and how well the last run held on.
//
// Moved out of VideoAnalysis.tsx (N6) as it was; the page keeps the state.
// ---------------------------------------------------------------------------

// A clip whose length is not known yet (a recorder WebM reports Infinity) ends at "the end", not "Infinity:NaN".
const fmt = (s: number) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : 'the end')

export interface TrackingControlsProps {
  mode: StageMode
  /** The pen's mode switch, and leaving calibrate mode. */
  onModeChange: (next: StageMode) => void
  /** Into calibrate mode, or back out of it. */
  onToggleCalibrate: () => void
  awaitingSecondPoint: boolean
  hasSeed: boolean
  hasSamples: boolean
  onResizeSeed: (delta: number) => void
  busy: boolean
  showPose: boolean
  onShowPose: (on: boolean) => void
  poseStatus: string
  poseError: string | null
  correctionsCount: number
  showAngles: boolean
  onShowAngles: (next: boolean) => void
  color: string
  onColor: (color: string) => void
  range: { from: number; to: number } | null
  duration: number
  onSetStart: () => void
  onSetEnd: () => void
  plateMm: number
  onPlateMm: (mm: number) => void
  pixelsPerMetre: number | null
  calibrationPx: number
  progress: number
  canTrack: boolean
  onTrack: () => void
  onCancel: () => void
  onClear: () => void
  strokes: Stroke[]
  onStrokesChange: (next: Stroke[]) => void
  quality: TrackQuality | null
  pathPoints: number | null
}

export default function TrackingControls(p: TrackingControlsProps) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-2 text-sm">
          <Crosshair className="h-4 w-4 text-muted-foreground" />
          {p.mode === 'calibrate'
            // Top and bottom, not left and right (D52): filmed at an angle the
            // plate is an ellipse, and only its height is still the diameter.
            ? 'Click the top and bottom edge of a plate to set the scale'
            : p.hasSamples
              ? 'Tracked — play the clip to watch the dot follow the bar'
              : p.hasSeed
                ? 'Point set — the circle is the search area, then track'
                : 'Click the middle of a plate to place the tracking point'}
        </span>
        {p.hasSeed && (
          <>
            <Button size="sm" variant="outline" onClick={() => p.onResizeSeed(-8)} disabled={p.busy}>−</Button>
            <Button size="sm" variant="outline" onClick={() => p.onResizeSeed(8)} disabled={p.busy}>+</Button>
          </>
        )}

        {/* Locked only WHILE a run is under way — the fan-out that feeds pose is
            set up at the start of that pass, so switching it mid-track would
            silently do nothing. Otherwise it takes effect at once: the preview
            runs on whatever frame is on screen. */}
        <label
          className={`flex items-center gap-1.5 text-sm ${p.busy ? 'opacity-50' : ''}`}
          title={p.busy ? 'Pose cannot be switched during a tracking run' : 'Draw the lifter’s skeleton — drag a joint to correct it'}
        >
          <input
            type="checkbox"
            checked={p.showPose}
            disabled={p.busy}
            onChange={(e) => p.onShowPose(e.target.checked)}
            className="h-3.5 w-3.5 accent-cyan-400"
          />
          <PersonStanding className="h-4 w-4 text-muted-foreground" />
          Skeleton
        </label>
        {/* The joints' degrees (D56), only meaningful with the skeleton on. */}
        <label className={`flex items-center gap-1.5 text-sm ${p.showPose ? '' : 'opacity-50'}`} title="Show each joint's angle in degrees on the skeleton">
          <input
            type="checkbox"
            checked={p.showAngles}
            disabled={!p.showPose}
            onChange={(e) => p.onShowAngles(e.target.checked)}
            className="h-3.5 w-3.5 accent-cyan-400"
          />
          Angles
        </label>
        {p.poseStatus === 'loading' && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the pose model…
          </span>
        )}
        {p.poseStatus === 'error' && <span className="text-xs text-destructive">Skeleton unavailable: {p.poseError}</span>}
        {p.correctionsCount > 0 && (
          <span className="text-xs text-muted-foreground">
            {p.correctionsCount} joint{p.correctionsCount === 1 ? '' : 's'} corrected
          </span>
        )}

        <span className="ml-auto flex items-center gap-1.5">
          <Palette className="h-4 w-4 text-muted-foreground" />
          {TRACKER_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              title={c.name}
              aria-label={`${c.name} overlay`}
              aria-pressed={p.color === c.value}
              onClick={() => p.onColor(c.value)}
              className={`h-5 w-5 rounded-full border transition-transform ${
                p.color === c.value ? 'scale-110 border-foreground ring-2 ring-foreground/30' : 'border-border hover:scale-110'
              }`}
              style={{ backgroundColor: c.value }}
            />
          ))}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Track from</span>
        <Button size="sm" variant="outline" disabled={p.busy} onClick={p.onSetStart}>
          Set start ({fmt(p.range?.from ?? 0)})
        </Button>
        <Button size="sm" variant="outline" disabled={p.busy} onClick={p.onSetEnd}>
          Set end ({fmt(p.range?.to ?? p.duration)})
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Ruler className="h-4 w-4 text-muted-foreground" />
        <span className="text-muted-foreground">Scale</span>
        <select
          value={p.plateMm}
          onChange={(e) => p.onPlateMm(Number(e.target.value))}
          disabled={p.busy}
          className="rounded-md border bg-background px-2 py-1 text-sm"
        >
          {PLATE_DIAMETERS_MM.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
        <Button size="sm" variant={p.mode === 'calibrate' ? 'default' : 'outline'} disabled={p.busy} onClick={p.onToggleCalibrate}>
          {p.mode === 'calibrate'
            ? p.awaitingSecondPoint ? 'Now click its bottom edge' : 'Click the top edge of the plate'
            : p.pixelsPerMetre ? 'Redo scale' : 'Set scale'}
        </Button>
        {p.pixelsPerMetre ? (
          <span className="text-muted-foreground">
            {Math.round(p.calibrationPx)} px across a {p.plateMm} mm plate — velocity in m/s. Drag either end to adjust it.
          </span>
        ) : (
          <span className="text-muted-foreground">Not set — velocity will be in pixels/second</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {p.busy ? (
          <Button variant="outline" onClick={p.onCancel}>
            <Loader2 className="h-4 w-4 animate-spin" />
            {`Tracking… ${Math.round(p.progress * 100)}% — stop and keep`}
          </Button>
        ) : (
          <Button onClick={p.onTrack} disabled={!p.canTrack}>
            <Target className="h-4 w-4" />
            {p.hasSamples ? 'Track again' : 'Track bar path'}
          </Button>
        )}
        {(p.hasSeed || p.hasSamples) && (
          <Button variant="ghost" onClick={p.onClear} disabled={p.busy}>
            <RotateCcw className="h-4 w-4" /> Clear
          </Button>
        )}

        {/* Drawing on the lift. Fullscreen is NOT here — it belongs in the
            video's own control bar, where a fullscreen button always is, and
            the stage puts it there itself. */}
        <div className="ml-auto">
          <DrawControls mode={p.mode} onModeChange={p.onModeChange} strokes={p.strokes} onStrokesChange={p.onStrokesChange} />
        </div>
      </div>

      {p.busy && (
        <p className="text-xs text-muted-foreground">
          Every frame of the range is read and tracked — usually faster than the clip plays. The path draws as it goes.
        </p>
      )}

      {p.quality && (
        <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <Stat label="Points followed" value={`${p.quality.seededPoints}`} />
          <Stat label="Kept per frame" value={`${Math.round(p.quality.medianSurvivalRate * 100)}%`} />
          <Stat label="Re-locks" value={`${p.quality.reseeds}`} />
          <Stat label="Held for" value={p.quality.lostAtFrame === null ? 'the whole range' : `${p.quality.lostAtFrame} frames`} />
          <Stat label="Effective frame rate" value={`${p.quality.effectiveFps.toFixed(1)} fps`} />
          {p.pathPoints != null && <Stat label="Path points" value={`${p.pathPoints}`} />}
        </div>
      )}
    </>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b py-1 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}
