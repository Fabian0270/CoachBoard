import type { SuggestionGoal, SuggestionTemplateInfo } from 'coachboard-shared'
import { GOAL_LABELS } from './constants'
import BackButton from './BackButton'

interface VariantStepProps {
  goal: SuggestionGoal
  variants: SuggestionTemplateInfo[]
  onPickVariant: (t: SuggestionTemplateInfo) => void
  onBack: () => void
}

export default function VariantStep({ goal, variants, onPickVariant, onBack }: VariantStepProps) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground mb-3">
        Choose a {GOAL_LABELS[goal].toLowerCase()} approach:
      </p>
      {variants.map((t) => (
        <button
          key={t.id}
          onClick={() => onPickVariant(t)}
          className="w-full text-left rounded-lg border p-3 hover:bg-accent transition-colors"
        >
          <div className="font-medium">{t.label}</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Typical length: {t.typicalWeeks[0]}–{t.typicalWeeks[1]} weeks
          </div>
        </button>
      ))}
      <BackButton onClick={onBack} />
    </div>
  )
}
