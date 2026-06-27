import { ChevronLeft } from 'lucide-react'
import { TRAINING_DAY_OPTIONS } from './constants'
import BackButton from './BackButton'

interface DaysStepProps {
  showSplitPicker: boolean
  onShowSplitPicker: () => void
  onHideSplitPicker: () => void
  onChooseMirror: () => void
  onPickDays: (d: 3 | 4 | 5) => void
  onBack: () => void
}

export default function DaysStep({
  showSplitPicker, onShowSplitPicker, onHideSplitPicker, onChooseMirror, onPickDays, onBack,
}: DaysStepProps) {
  return (
    <div className="space-y-3">
      {!showSplitPicker ? (
        <>
          <p className="text-sm text-muted-foreground mb-1">How should the new block's weekly structure be set?</p>
          <button
            onClick={onChooseMirror}
            className="w-full text-left rounded-lg border border-primary/30 bg-primary/5 p-3 hover:bg-primary/10 transition-colors"
          >
            <div className="font-medium">Match the source program's structure</div>
            <div className="text-sm text-muted-foreground mt-0.5">
              Keeps this athlete's training days and any full-body (SBD) days, with each lift's accessories.
            </div>
          </button>
          <button
            onClick={onShowSplitPicker}
            className="w-full text-left rounded-lg border p-3 hover:bg-accent transition-colors"
          >
            <div className="font-medium">Use a standard split</div>
            <div className="text-sm text-muted-foreground mt-0.5">
              Lay the lifts out one per day across 3, 4 or 5 training days.
            </div>
          </button>
          <BackButton onClick={onBack} />
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground mb-1">How many training days per week?</p>
          <div className="flex gap-2">
            {TRAINING_DAY_OPTIONS.map((d) => (
              <button
                key={d}
                onClick={() => onPickDays(d)}
                className="flex-1 rounded-lg border py-4 text-center font-semibold text-lg hover:bg-accent transition-colors"
              >
                {d}
                <div className="text-xs font-normal text-muted-foreground mt-0.5">days/week</div>
              </button>
            ))}
          </div>
          <button
            onClick={onHideSplitPicker}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mt-1"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Back to structure options
          </button>
        </>
      )}
    </div>
  )
}
