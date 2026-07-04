import type { Dispatch, SetStateAction } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Loader2, Sparkles } from 'lucide-react'
import type { CoachStyleProfile, DetectedPattern, SuggestionGoal, SuggestionTemplateInfo } from 'coachboard-shared'
import { GOAL_LABELS } from './constants'
import { clampDays, repBiasFor } from './helpers'
import BackButton from './BackButton'
import TemplatePicker from '../TemplatePicker'

interface OptionsStepProps {
  template: SuggestionTemplateInfo
  trainingDays: 3 | 4 | 5
  selectedPattern: DetectedPattern | null
  styleProfile: CoachStyleProfile | null
  useStyle: boolean
  goal: SuggestionGoal | null
  weeks: number
  setWeeks: Dispatch<SetStateAction<number>>
  startDate: string
  setStartDate: Dispatch<SetStateAction<string>>
  enrichAccessories: boolean
  setEnrichAccessories: Dispatch<SetStateAction<boolean>>
  builtinTemplate: string
  setBuiltinTemplate: Dispatch<SetStateAction<string>>
  loading: boolean
  error: string | null
  onToggleStyle: () => void
  onBack: () => void
  onGenerate: () => void
}

export default function OptionsStep({
  template, trainingDays, selectedPattern, styleProfile, useStyle, goal,
  weeks, setWeeks, startDate, setStartDate, enrichAccessories, setEnrichAccessories,
  builtinTemplate, setBuiltinTemplate,
  loading, error, onToggleStyle, onBack, onGenerate,
}: OptionsStepProps) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
        <span className="text-muted-foreground">Template: </span>
        <span className="font-medium">{GOAL_LABELS[template.goal]} — {template.label}</span>
        <span className="text-muted-foreground"> · {trainingDays} days/week</span>
      </div>

      {selectedPattern ? (
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              Your “{selectedPattern.label}” pattern
            </span>
            <button type="button" onClick={onToggleStyle} className="text-xs text-muted-foreground underline shrink-0">
              {useStyle ? 'Use generic defaults' : 'Apply my pattern'}
            </button>
          </div>
          {useStyle ? (
            <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5">
              <li>Block length set to {selectedPattern.preferredBlockWeeks} weeks</li>
              <li>Defaulted to {clampDays(selectedPattern.preferredDaysPerWeek)} days/week</li>
              {selectedPattern.typicalStartRpe != null && selectedPattern.typicalPeakRpe != null && (
                <li>RPE arc tuned to your usual {selectedPattern.typicalStartRpe} → {selectedPattern.typicalPeakRpe}</li>
              )}
              {selectedPattern.preferredRepRange && repBiasFor(selectedPattern.goal, selectedPattern.preferredRepRange) !== 0 && (
                <li>Reps nudged toward your {selectedPattern.preferredRepRange} range</li>
              )}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Using the generic template defaults — your pattern parameters are ignored.</p>
          )}
          <p className="text-[11px] text-muted-foreground/80">
            Detected across {selectedPattern.sampleSize} of your programs.
          </p>
        </div>
      ) : styleProfile?.usable && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              Based on your last {styleProfile.sampleSize} {GOAL_LABELS[template.goal].toLowerCase()} programs
            </span>
            <button type="button" onClick={onToggleStyle} className="text-xs text-muted-foreground underline shrink-0">
              {useStyle ? 'Use generic defaults' : 'Apply my style'}
            </button>
          </div>
          {useStyle ? (
            <ul className="text-xs text-muted-foreground list-disc list-inside space-y-0.5">
              {styleProfile.preferredBlockWeeks && <li>Block length set to {styleProfile.preferredBlockWeeks} weeks</li>}
              {styleProfile.preferredDaysPerWeek && <li>Defaulted to {clampDays(styleProfile.preferredDaysPerWeek)} days/week</li>}
              {styleProfile.typicalStartRpe != null && styleProfile.typicalPeakRpe != null && (
                <li>RPE arc tuned to your usual {styleProfile.typicalStartRpe} → {styleProfile.typicalPeakRpe}</li>
              )}
              {goal && styleProfile.preferredRepRange && repBiasFor(goal, styleProfile.preferredRepRange) !== 0 && (
                <li>Reps nudged toward your {styleProfile.preferredRepRange} range</li>
              )}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">Using the generic template defaults — your style profile is ignored.</p>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="sg-weeks">
            Weeks
            <span className="ml-1 text-xs text-muted-foreground font-normal">
              (typical {template.typicalWeeks[0]}–{template.typicalWeeks[1]})
            </span>
          </Label>
          <Input
            id="sg-weeks"
            type="number"
            min={1}
            max={52}
            value={weeks}
            onChange={(e) => setWeeks(Math.max(1, parseInt(e.target.value) || 1))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sg-start">Start date</Label>
          <Input
            id="sg-start"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
      </div>

      <label className="flex items-start gap-2 rounded-lg border p-3 cursor-pointer hover:bg-accent/50 transition-colors">
        <input
          type="checkbox"
          checked={enrichAccessories}
          onChange={(e) => setEnrichAccessories(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium text-sm">Suggest accessories for empty lifts</span>
          <span className="block text-xs text-muted-foreground mt-0.5">
            Only for main lifts with no accessories in the source program. Suggestions are
            tagged so you can edit or remove them; your own accessories are never changed.
          </span>
        </span>
      </label>

      <div className="space-y-1.5">
        <Label>Excel template</Label>
        <TemplatePicker
          value={builtinTemplate}
          onChange={setBuiltinTemplate}
          inheritOption={{
            label: 'Same as source program',
            description: 'Keep the look of the program this draft is based on.',
          }}
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2 pt-1">
        <BackButton onClick={onBack} />
        <Button
          className="flex-1"
          onClick={onGenerate}
          disabled={loading || !startDate}
        >
          {loading ? (
            <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Generating…</>
          ) : (
            <><Sparkles className="h-4 w-4 mr-2" /> Generate draft</>
          )}
        </Button>
      </div>
    </div>
  )
}
