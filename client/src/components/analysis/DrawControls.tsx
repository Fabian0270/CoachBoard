import { Eraser, Pencil, Undo2 } from 'lucide-react'
import { Button } from '../ui/button'
import type { StageMode } from './AnalysisStage'
import type { Stroke } from './annotations'

// ---------------------------------------------------------------------------
// The pen, and the two ways to take it back.
//
// Shared rather than written twice because drawing has to behave identically
// wherever a lift is on screen: a coach explaining a knee angle should not find
// that the pen works on one page and not the next. Undo and Erase appear only
// once there is something to undo, so the row stays quiet until it is used.
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

export default function DrawControls({
  mode,
  onModeChange,
  strokes,
  onStrokesChange,
  compact,
}: Props) {
  const drawing = mode === 'draw'
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
