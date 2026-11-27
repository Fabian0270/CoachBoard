import { VBT_LIFTS, liftLabel, type VbtLift } from 'coachboard-shared/vbt'
import { Button } from '../ui/button'

// ---------------------------------------------------------------------------
// "Which lift is this?" — asked first thing when a clip is opened (D126).
//
// The page used to start on the lift last worked on, silently. Most of what it
// shows depends on the lift — the pause verdict only on a bench, the lockout
// column and the mid-foot line only on a squat or deadlift, which limbs the
// skeleton draws, which velocity table the reps are read against — so a bench
// clip opened after a run of squats was read as a squat without a word. Now the
// coach answers before the plate can be clicked. When the clip already says
// (a Discord caption, a set recorded on the camera or phone screen) that lift
// is picked out, and one click confirms it.
// ---------------------------------------------------------------------------

export interface KnownLift {
  lift: VbtLift
  from: 'caption' | 'recording'
}

const FROM_LABEL: Record<KnownLift['from'], string> = {
  caption: 'from the caption',
  recording: 'picked when it was recorded',
}

export default function LiftPrompt({ known, onPick }: { known: KnownLift | null; onPick: (lift: VbtLift) => void }) {
  return (
    <div className="rounded-md border border-primary/40 bg-primary/5 p-3" role="group" aria-label="Which lift is this?">
      <p className="mb-2 text-sm font-medium">
        Which lift is this?
        {known && (
          <span className="ml-1.5 font-normal text-muted-foreground">
            {liftLabel(known.lift)}, {FROM_LABEL[known.from]} — click it to confirm.
          </span>
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {VBT_LIFTS.map((l) => (
          <Button
            key={l.id}
            size="sm"
            variant={known?.lift === l.id ? 'default' : 'outline'}
            aria-pressed={known?.lift === l.id}
            onClick={() => onPick(l.id)}
          >
            {l.label}
          </Button>
        ))}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        The pause check, the lockout marks, the skeleton and the speed readings all depend on it.
      </p>
    </div>
  )
}
