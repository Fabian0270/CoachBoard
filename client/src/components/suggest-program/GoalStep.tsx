import { Sparkles } from 'lucide-react'
import type { DetectedPattern, SuggestionGoal } from 'coachboard-shared'
import { GOAL_LABELS, GOAL_DESCRIPTIONS } from './constants'
import BackButton from './BackButton'

interface GoalStepProps {
  patterns: DetectedPattern[]
  showBack: boolean
  onPickPattern: (p: DetectedPattern) => void
  onPickGoal: (g: SuggestionGoal) => void
  onBack: () => void
}

export default function GoalStep({ patterns, showBack, onPickPattern, onPickGoal, onBack }: GoalStepProps) {
  return (
    <div className="space-y-2">
      {patterns.length > 0 && (
        <div className="space-y-2 mb-1">
          <p className="text-sm text-muted-foreground">
            Reuse one of your own patterns — pre-filled with how you usually program it:
          </p>
          {patterns.map((p) => (
            <button
              key={p.id}
              onClick={() => onPickPattern(p)}
              className="w-full text-left rounded-lg border border-primary/30 bg-primary/5 p-3 hover:bg-primary/10 transition-colors"
            >
              <div className="font-medium flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-primary shrink-0" />
                Use your “{p.label}” pattern
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {p.description} · from {p.sampleSize} program{p.sampleSize !== 1 ? 's' : ''}
              </div>
            </button>
          ))}
          <div className="flex items-center gap-2 pt-1">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or pick a generic goal</span>
            <div className="h-px flex-1 bg-border" />
          </div>
        </div>
      )}
      <p className="text-sm text-muted-foreground mb-3">What is the primary goal of the next block?</p>
      {(['hypertrophy', 'strength', 'peaking'] as SuggestionGoal[]).map((g) => (
        <button
          key={g}
          onClick={() => onPickGoal(g)}
          className="w-full text-left rounded-lg border p-3 hover:bg-accent transition-colors"
        >
          <div className="font-medium">{GOAL_LABELS[g]}</div>
          <div className="text-sm text-muted-foreground mt-0.5">{GOAL_DESCRIPTIONS[g]}</div>
        </button>
      ))}
      {showBack && <BackButton onClick={onBack} />}
    </div>
  )
}
