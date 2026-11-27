import { Circle, Eraser, MoveUpRight, MoveVertical, Pencil, Slash, Undo2, type LucideIcon } from 'lucide-react'
import { Button } from '../ui/button'
import type { StageMode } from './AnalysisStage'
import type { PenTool, Stroke } from './annotations'
import { usePenTool } from './penTool'

// ---------------------------------------------------------------------------
// The pen, its shapes, and the two ways to take it back.
//
// Shared rather than written twice because drawing has to behave identically
// wherever a lift is on screen: a coach explaining a knee angle should not find
// that the pen works on one page and not the next. Undo and Erase appear only
// once there is something to undo, so the row stays quiet until it is used.
// The shapes (BP30) show while drawing: freehand, line, arrow, circle, and a
// plumb line straight up and down through a click.
// ---------------------------------------------------------------------------

interface Props {
  mode: StageMode
  /** Called with the mode the stage should switch to. */
  onModeChange: (next: StageMode) => void
  strokes: Stroke[]
  onStrokesChange: (next: Stroke[]) => void
  /** Compact variant for a comparison pane, where space is halved. */
  compact?: boolean
}

const TOOLS: { tool: PenTool; label: string; icon: LucideIcon }[] = [
  { tool: 'free', label: 'Freehand', icon: Pencil },
  { tool: 'line', label: 'Straight line', icon: Slash },
  { tool: 'arrow', label: 'Arrow', icon: MoveUpRight },
  { tool: 'circle', label: 'Circle — drag from its centre', icon: Circle },
  { tool: 'plumb', label: 'Plumb line — straight up and down through a click', icon: MoveVertical },
]

export default function DrawControls({
  mode,
  onModeChange,
  strokes,
  onStrokesChange,
  compact,
}: Props) {
  const drawing = mode === 'draw'
  const [tool, setTool] = usePenTool()
  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant={drawing ? 'default' : 'outline'}
        // Deliberately never disabled: pointing at a knee is worth doing whether
        // or not the bar has been tracked, and it is what a screen recording of
        // the session captures.
        onClick={() => onModeChange(drawing ? 'seed' : 'draw')}
        title="Draw on the video"
      >
        <Pencil className="h-4 w-4" />
        {compact ? null : drawing ? 'Drawing' : 'Draw'}
      </Button>
      {drawing && (
        <div role="group" aria-label="Pen shape" className="flex items-center rounded-md border p-0.5">
          {TOOLS.map(({ tool: t, label, icon: Icon }) => (
            <button
              key={t}
              type="button"
              aria-pressed={tool === t}
              aria-label={label}
              title={label}
              onClick={() => setTool(t)}
              className={`rounded p-1 transition-colors ${tool === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      )}
      {strokes.length > 0 && (
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onStrokesChange(strokes.slice(0, -1))}
            title="Undo the last mark"
            aria-label="Undo the last mark"
          >
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onStrokesChange([])}
            title="Erase every mark"
            aria-label="Erase every mark"
          >
            <Eraser className="h-4 w-4" />
          </Button>
        </>
      )}
    </div>
  )
}
