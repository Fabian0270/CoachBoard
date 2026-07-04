import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Sparkles } from 'lucide-react'
import { SUGGESTION_TEMPLATES } from 'coachboard-shared'
import { knowledgeDefaultsForGoal } from 'coachboard-shared/knowledge'
import type { SuggestionGoal, SuggestionTemplateInfo, SuggestionStyleAdjust, DetectedPattern } from 'coachboard-shared'
import type { Props, SelectableProgram, Step } from './types'
import { clampDays, firstStep, repBiasFor, todayIso } from './helpers'
import { usePatterns } from './hooks/usePatterns'
import { useStyleProfile } from './hooks/useStyleProfile'
import { useSourceSelection } from './hooks/useSourceSelection'
import AthleteStep from './AthleteStep'
import SourceStep from './SourceStep'
import GoalStep from './GoalStep'
import VariantStep from './VariantStep'
import DaysStep from './DaysStep'
import OptionsStep from './OptionsStep'

export function SuggestProgramDialog({ open, onOpenChange, programId, athleteId, onCreated }: Props) {
  const stepList: Step[] = [
    ...(!programId && !athleteId ? (['athlete'] as Step[]) : []),
    ...(!programId ? (['source'] as Step[]) : []),
    'goal', 'variant', 'days', 'options',
  ]

  const [step, setStep] = useState<Step>(() => firstStep(programId, athleteId))
  const [pickedAthleteId, setPickedAthleteId] = useState<string | null>(null)
  const [pickedProgramId, setPickedProgramId] = useState<string | null>(null)
  // The source program can come from another athlete (e.g. a brand-new athlete
  // with no programs reusing a colleague's block). `sourceAthleteId === null`
  // means "this athlete"; `pickingSourceAthlete` shows the athlete picker.
  const [sourceAthleteId, setSourceAthleteId] = useState<string | null>(null)
  const [pickingSourceAthlete, setPickingSourceAthlete] = useState(false)
  const [goal, setGoal] = useState<SuggestionGoal | null>(null)
  const [template, setTemplate] = useState<SuggestionTemplateInfo | null>(null)
  const [trainingDays, setTrainingDays] = useState<3 | 4 | 5>(4)
  // 'source' mirrors the source program's weekly structure (default); 'split' uses
  // the generic 3/4/5 one-lift-per-day layout. `showSplitPicker` reveals the
  // day-count buttons once the coach opts into a standard split.
  const [layout, setLayout] = useState<'source' | 'split'>('source')
  const [showSplitPicker, setShowSplitPicker] = useState(false)
  // Opt-in: suggest weak-point accessories for main lifts that have none. Off by
  // default so the draft only ever mirrors the coach's own accessories.
  const [enrichAccessories, setEnrichAccessories] = useState(false)
  const [weeks, setWeeks] = useState(4)
  const [startDate, setStartDate] = useState(todayIso)
  // '' = inherit the source program's template; otherwise a built-in id.
  const [builtinTemplate, setBuiltinTemplate] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [useStyle, setUseStyle] = useState(true)
  const [selectedPattern, setSelectedPattern] = useState<DetectedPattern | null>(null)

  const { patterns, setPatterns } = usePatterns(open)
  const { styleProfile, setStyleProfile } = useStyleProfile({ open, goal, selectedPattern, setTrainingDays, setUseStyle })
  const {
    sourceAthletes, setSourceAthletes,
    sourcePrograms, setSourcePrograms,
    sourcesLoading, setSourcesLoading,
    sourcesError, setSourcesError,
  } = useSourceSelection({ open, step, pickingSourceAthlete, athleteId, pickedAthleteId, sourceAthleteId })

  function reset() {
    setStep(firstStep(programId, athleteId))
    setPickedAthleteId(null)
    setPickedProgramId(null)
    setSourceAthletes(null)
    setSourcePrograms(null)
    setSourceAthleteId(null)
    setPickingSourceAthlete(false)
    setSourcesLoading(false)
    setSourcesError(null)
    setGoal(null)
    setTemplate(null)
    setTrainingDays(4)
    setLayout('source')
    setShowSplitPicker(false)
    setEnrichAccessories(false)
    setWeeks(4)
    setStartDate(todayIso())
    setBuiltinTemplate('')
    setLoading(false)
    setError(null)
    setStyleProfile(null)
    setUseStyle(true)
    setPatterns([])
    setSelectedPattern(null)
  }

  function handleOpenChange(v: boolean) {
    if (!v) reset()
    onOpenChange(v)
  }

  function goBack() {
    // A selected pattern jumps straight to options, skipping goal/variant/days —
    // backing out of it drops the pattern and returns to the goal picker.
    if (step === 'options' && selectedPattern) {
      setSelectedPattern(null)
      setStep('goal')
      return
    }
    const idx = stepList.indexOf(step)
    if (idx > 0) setStep(stepList[idx - 1])
  }

  function pickAthlete(aId: string) {
    setPickedAthleteId(aId)
    setSourcePrograms(null)
    setStep('source')
  }

  function pickSourceProgram(prog: SelectableProgram) {
    setPickedProgramId(prog.id)
    setStep('goal')
  }

  // Switch the source program list to a different athlete's programs.
  function pickSourceAthlete(aId: string) {
    setSourceAthleteId(aId)
    setSourcePrograms(null) // trigger refetch for the new athlete
    setPickingSourceAthlete(false)
  }

  // Return the source list to the athlete the program is being generated for.
  function resetToOwnAthlete() {
    setSourceAthleteId(null)
    setSourcePrograms(null)
  }

  function pickGoal(g: SuggestionGoal) {
    setSelectedPattern(null)
    setGoal(g)
    setTemplate(null)
    setStep('variant')
  }

  // A detected pattern pre-fills template + block length + days + RPE arc from the
  // coach's own typical parameters, then jumps straight to the options review.
  function pickPattern(p: DetectedPattern) {
    const tmpl = SUGGESTION_TEMPLATES.find((t) => t.id === p.templateId) ?? null
    setSelectedPattern(p)
    setGoal(p.goal)
    setTemplate(tmpl)
    setTrainingDays(clampDays(p.preferredDaysPerWeek))
    setWeeks(p.preferredBlockWeeks)
    setUseStyle(true)
    setStep('options')
  }

  function styleAdjustFromPattern(p: DetectedPattern): SuggestionStyleAdjust | undefined {
    const s: SuggestionStyleAdjust = {}
    if (p.typicalStartRpe != null) s.startRpe = p.typicalStartRpe
    if (p.typicalPeakRpe != null) s.peakRpe = p.typicalPeakRpe
    const bias = repBiasFor(p.goal, p.preferredRepRange)
    if (bias !== 0) s.repBias = bias
    return Object.keys(s).length > 0 ? s : undefined
  }

  function pickVariant(t: SuggestionTemplateInfo) {
    setTemplate(t)
    // Default block length to the knowledge base's typical for this goal (clamped
    // into the variant's sane range), unless the style profile later overrides it.
    const kd = goal ? knowledgeDefaultsForGoal(goal).weeks : t.typicalWeeks[0]
    setWeeks(Math.min(t.typicalWeeks[1], Math.max(t.typicalWeeks[0], kd)))
    setShowSplitPicker(false)
    setStep('days')
  }

  // Default the block length to the coach's usual when their style is in play —
  // shared by both the mirror and the standard-split paths.
  function applyStyleWeeks() {
    if (useStyle && styleProfile?.usable && styleProfile.preferredBlockWeeks) {
      setWeeks(styleProfile.preferredBlockWeeks)
    }
  }

  function chooseMirror() {
    setLayout('source')
    applyStyleWeeks()
    setStep('options')
  }

  function pickDays(d: 3 | 4 | 5) {
    setLayout('split')
    setTrainingDays(d)
    applyStyleWeeks()
    setStep('options')
  }

  // Flip between style-tuned and generic defaults, re-prefilling the block length
  // so what the coach sees in the Weeks input always matches the active mode.
  function toggleStyle() {
    const next = !useStyle
    setUseStyle(next)
    if (next && selectedPattern) {
      setWeeks(selectedPattern.preferredBlockWeeks)
    } else if (next && styleProfile?.usable && styleProfile.preferredBlockWeeks) {
      setWeeks(styleProfile.preferredBlockWeeks)
    } else if (!next && template) {
      setWeeks(template.typicalWeeks[0])
    }
  }

  function buildStyleAdjust(): SuggestionStyleAdjust | undefined {
    if (!useStyle) return undefined
    if (selectedPattern) return styleAdjustFromPattern(selectedPattern)
    if (!goal || !styleProfile?.usable) return undefined
    const s: SuggestionStyleAdjust = {}
    if (styleProfile.typicalStartRpe != null) s.startRpe = styleProfile.typicalStartRpe
    if (styleProfile.typicalPeakRpe != null) s.peakRpe = styleProfile.typicalPeakRpe
    const bias = repBiasFor(goal, styleProfile.preferredRepRange)
    if (bias !== 0) s.repBias = bias
    return Object.keys(s).length > 0 ? s : undefined
  }

  async function handleGenerate() {
    if (!template || !startDate) return
    const effectiveProgramId = programId ?? pickedProgramId
    const effectiveAthleteId = athleteId ?? pickedAthleteId
    if (!effectiveProgramId || !effectiveAthleteId) return
    setLoading(true)
    setError(null)
    try {
      const style = buildStyleAdjust()
      const res = await fetch(`/api/programs/${effectiveProgramId}/suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athleteId: effectiveAthleteId,
          templateId: template.id,
          weeks,
          trainingDaysPerWeek: trainingDays,
          startDate,
          layout,
          enrichAccessories,
          ...(style ? { style } : {}),
          ...(builtinTemplate ? { builtin_template: builtinTemplate } : {}),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Request failed')
      handleOpenChange(false)
      onCreated(data.draftProgramId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  const variantsForGoal = goal ? SUGGESTION_TEMPLATES.filter((t) => t.goal === goal) : []
  const stepIdx = stepList.indexOf(step)

  const targetAthleteId = athleteId ?? pickedAthleteId
  const viewingOtherAthlete = sourceAthleteId !== null && sourceAthleteId !== targetAthleteId
  const sourceAthleteName = sourceAthletes?.find((a) => a.id === sourceAthleteId)?.name ?? null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            Generate next program
          </DialogTitle>
        </DialogHeader>

        <div className="flex gap-1 mb-2">
          {stepList.map((s, i) => (
            <div
              key={s}
              className={`h-1 flex-1 rounded-full transition-colors ${i <= stepIdx ? 'bg-primary' : 'bg-muted'}`}
            />
          ))}
        </div>

        {step === 'athlete' && (
          <AthleteStep
            sourcesLoading={sourcesLoading}
            sourcesError={sourcesError}
            sourceAthletes={sourceAthletes}
            onPick={pickAthlete}
          />
        )}

        {step === 'source' && (
          <SourceStep
            pickingSourceAthlete={pickingSourceAthlete}
            sourcesLoading={sourcesLoading}
            sourcesError={sourcesError}
            sourceAthletes={sourceAthletes}
            sourcePrograms={sourcePrograms}
            targetAthleteId={targetAthleteId}
            viewingOtherAthlete={viewingOtherAthlete}
            sourceAthleteName={sourceAthleteName}
            showBack={stepIdx > 0}
            onPickSourceAthlete={pickSourceAthlete}
            onStopPickingSourceAthlete={() => setPickingSourceAthlete(false)}
            onStartPickingSourceAthlete={() => setPickingSourceAthlete(true)}
            onResetToOwnAthlete={resetToOwnAthlete}
            onPickSourceProgram={pickSourceProgram}
            onBack={goBack}
          />
        )}

        {step === 'goal' && (
          <GoalStep
            patterns={patterns}
            showBack={stepIdx > 0}
            onPickPattern={pickPattern}
            onPickGoal={pickGoal}
            onBack={goBack}
          />
        )}

        {step === 'variant' && goal && (
          <VariantStep goal={goal} variants={variantsForGoal} onPickVariant={pickVariant} onBack={goBack} />
        )}

        {step === 'days' && (
          <DaysStep
            showSplitPicker={showSplitPicker}
            onShowSplitPicker={() => setShowSplitPicker(true)}
            onHideSplitPicker={() => setShowSplitPicker(false)}
            onChooseMirror={chooseMirror}
            onPickDays={pickDays}
            onBack={goBack}
          />
        )}

        {step === 'options' && template && (
          <OptionsStep
            template={template}
            trainingDays={trainingDays}
            selectedPattern={selectedPattern}
            styleProfile={styleProfile}
            useStyle={useStyle}
            goal={goal}
            weeks={weeks}
            setWeeks={setWeeks}
            startDate={startDate}
            setStartDate={setStartDate}
            enrichAccessories={enrichAccessories}
            setEnrichAccessories={setEnrichAccessories}
            builtinTemplate={builtinTemplate}
            setBuiltinTemplate={setBuiltinTemplate}
            loading={loading}
            error={error}
            onToggleStyle={toggleStyle}
            onBack={goBack}
            onGenerate={handleGenerate}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
