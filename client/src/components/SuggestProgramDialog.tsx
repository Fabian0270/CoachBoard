import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Loader2, ChevronLeft, Sparkles } from 'lucide-react'
import { SUGGESTION_TEMPLATES } from 'coachboard-shared'
import { knowledgeDefaultsForGoal } from 'coachboard-shared/knowledge'
import type { SuggestionGoal, SuggestionTemplateInfo, CoachStyleProfile, SuggestionStyleAdjust, RepRangeBucket, DetectedPattern } from 'coachboard-shared'

interface SelectableAthlete { id: string; name: string }
interface SelectableProgram { id: string; name: string; status: string; start_date: string | null }

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  programId?: string
  athleteId?: string
  onCreated: (draftProgramId: string) => void
}

type Step = 'athlete' | 'source' | 'goal' | 'variant' | 'days' | 'options'

const GOAL_LABELS: Record<SuggestionGoal, string> = {
  hypertrophy: 'Hypertrophy',
  strength: 'Strength',
  peaking: 'Peaking',
}
const GOAL_DESCRIPTIONS: Record<SuggestionGoal, string> = {
  hypertrophy: 'Higher volume, moderate intensity — builds the muscle base that supports heavier lifting.',
  strength: 'Moderate reps, rising intensity — develops force production through the competition lifts.',
  peaking: 'Low volume, high intensity — prepares the athlete to express maximum strength on a test or meet day.',
}

const TRAINING_DAY_OPTIONS = [3, 4, 5] as const

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

const clampDays = (n: number): 3 | 4 | 5 => (n <= 3 ? 3 : n >= 5 ? 5 : 4)

// Representative rep for a learned bucket vs. a goal's natural rep target — used
// to derive a gentle (±2) rep nudge toward how the coach usually programs.
const REP_MIDPOINT: Record<RepRangeBucket, number> = { '1-3': 2, '4-6': 5, '6-10': 8, '10+': 11 }
const GOAL_REP: Record<SuggestionGoal, number> = { hypertrophy: 8, strength: 4, peaking: 2 }
function repBiasFor(goal: SuggestionGoal, bucket: RepRangeBucket | null): number {
  if (!bucket) return 0
  const raw = Math.round((REP_MIDPOINT[bucket] - GOAL_REP[goal]) / 3)
  return Math.max(-2, Math.min(2, raw))
}

function firstStep(programId?: string, athleteId?: string): Step {
  if (programId) return 'goal'
  if (athleteId) return 'source'
  return 'athlete'
}

export function SuggestProgramDialog({ open, onOpenChange, programId, athleteId, onCreated }: Props) {
  const stepList: Step[] = [
    ...(!programId && !athleteId ? (['athlete'] as Step[]) : []),
    ...(!programId ? (['source'] as Step[]) : []),
    'goal', 'variant', 'days', 'options',
  ]

  const [step, setStep] = useState<Step>(() => firstStep(programId, athleteId))
  const [pickedAthleteId, setPickedAthleteId] = useState<string | null>(null)
  const [pickedProgramId, setPickedProgramId] = useState<string | null>(null)
  const [sourceAthletes, setSourceAthletes] = useState<SelectableAthlete[] | null>(null)
  const [sourcePrograms, setSourcePrograms] = useState<SelectableProgram[] | null>(null)
  const [sourcesLoading, setSourcesLoading] = useState(false)
  const [sourcesError, setSourcesError] = useState<string | null>(null)
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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [styleProfile, setStyleProfile] = useState<CoachStyleProfile | null>(null)
  const [useStyle, setUseStyle] = useState(true)
  const [patterns, setPatterns] = useState<DetectedPattern[]>([])
  const [selectedPattern, setSelectedPattern] = useState<DetectedPattern | null>(null)

  // Detected periodization patterns (Feature 5d) — fetched once per open, shown
  // as named shortcuts on the goal step alongside the generic goals.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetch('/api/style-profile/patterns')
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setPatterns(Array.isArray(data) ? data : []) })
      .catch(() => { if (!cancelled) setPatterns([]) })
    return () => { cancelled = true }
  }, [open])

  // Once the coach picks a goal, pull their style profile scoped to that focus.
  // When it's usable, default the day-count to their usual cadence. A selected
  // pattern owns the defaults, so don't let the profile clobber them.
  useEffect(() => {
    if (!open || !goal) return
    let cancelled = false
    setStyleProfile(null)
    fetch(`/api/style-profile?focus=${goal}`)
      .then((r) => r.json())
      .then((data: CoachStyleProfile) => {
        if (cancelled) return
        setStyleProfile(data)
        if (selectedPattern) return
        setUseStyle(data.usable)
        if (data.usable && data.preferredDaysPerWeek) {
          setTrainingDays(clampDays(data.preferredDaysPerWeek))
        } else if (!data.usable) {
          // No learned style yet → fall back to the knowledge base's typical
          // days-per-week for this goal. Silent default; the coach still sees
          // and can change it.
          setTrainingDays(clampDays(knowledgeDefaultsForGoal(goal).daysPerWeek))
        }
      })
      .catch(() => { if (!cancelled) setStyleProfile(null) })
    return () => { cancelled = true }
  }, [open, goal, selectedPattern])

  useEffect(() => {
    if (!open || step !== 'athlete' || sourceAthletes !== null) return
    setSourcesLoading(true)
    setSourcesError(null)
    fetch('/api/athletes')
      .then((r) => r.json())
      .then((data) => setSourceAthletes(Array.isArray(data) ? data : []))
      .catch(() => setSourcesError('Failed to load athletes'))
      .finally(() => setSourcesLoading(false))
  }, [open, step, sourceAthletes])

  useEffect(() => {
    const eid = athleteId ?? pickedAthleteId
    if (!open || step !== 'source' || sourcePrograms !== null || !eid) return
    setSourcesLoading(true)
    setSourcesError(null)
    fetch(`/api/programs?athlete_id=${eid}`)
      .then((r) => r.json())
      .then((data) => {
        const all = Array.isArray(data) ? (data as SelectableProgram[]) : []
        setSourcePrograms(all.filter((p) => p.status === 'completed' || p.status === 'archived'))
      })
      .catch(() => setSourcesError('Failed to load programs'))
      .finally(() => setSourcesLoading(false))
  }, [open, step, sourcePrograms, athleteId, pickedAthleteId])

  function reset() {
    setStep(firstStep(programId, athleteId))
    setPickedAthleteId(null)
    setPickedProgramId(null)
    setSourceAthletes(null)
    setSourcePrograms(null)
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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
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
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground mb-3">Select the athlete to generate a program for:</p>
            {sourcesLoading && <p className="text-sm text-muted-foreground">Loading athletes…</p>}
            {sourcesError && <p className="text-sm text-destructive">{sourcesError}</p>}
            {sourceAthletes !== null && sourceAthletes.length === 0 && (
              <p className="text-sm text-muted-foreground">No athletes found.</p>
            )}
            {sourceAthletes?.map((a) => (
              <button
                key={a.id}
                onClick={() => pickAthlete(a.id)}
                className="w-full text-left rounded-lg border p-3 hover:bg-accent transition-colors font-medium"
              >
                {a.name}
              </button>
            ))}
          </div>
        )}

        {step === 'source' && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground mb-3">Which completed or archived program should the new block be based on?</p>
            {sourcesLoading && <p className="text-sm text-muted-foreground">Loading programs…</p>}
            {sourcesError && <p className="text-sm text-destructive">{sourcesError}</p>}
            {sourcePrograms !== null && sourcePrograms.length === 0 && (
              <p className="text-sm text-muted-foreground">No completed or archived programs found for this athlete.</p>
            )}
            {sourcePrograms?.map((p) => (
              <button
                key={p.id}
                onClick={() => pickSourceProgram(p)}
                className="w-full text-left rounded-lg border p-3 hover:bg-accent transition-colors"
              >
                <div className="font-medium flex items-center justify-between gap-2">
                  <span>{p.name}</span>
                  {p.status === 'archived' && (
                    <span className="text-xs font-normal rounded bg-muted px-1.5 py-0.5 text-muted-foreground">archived</span>
                  )}
                </div>
                {p.start_date && (
                  <div className="text-xs text-muted-foreground mt-0.5">Started: {p.start_date}</div>
                )}
              </button>
            ))}
            {stepIdx > 0 && <BackButton onClick={goBack} />}
          </div>
        )}

        {step === 'goal' && (
          <div className="space-y-2">
            {patterns.length > 0 && (
              <div className="space-y-2 mb-1">
                <p className="text-sm text-muted-foreground">
                  Reuse one of your own patterns — pre-filled with how you usually program it:
                </p>
                {patterns.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => pickPattern(p)}
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
                onClick={() => pickGoal(g)}
                className="w-full text-left rounded-lg border p-3 hover:bg-accent transition-colors"
              >
                <div className="font-medium">{GOAL_LABELS[g]}</div>
                <div className="text-sm text-muted-foreground mt-0.5">{GOAL_DESCRIPTIONS[g]}</div>
              </button>
            ))}
            {stepIdx > 0 && <BackButton onClick={goBack} />}
          </div>
        )}

        {step === 'variant' && goal && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground mb-3">
              Choose a {GOAL_LABELS[goal].toLowerCase()} approach:
            </p>
            {variantsForGoal.map((t) => (
              <button
                key={t.id}
                onClick={() => pickVariant(t)}
                className="w-full text-left rounded-lg border p-3 hover:bg-accent transition-colors"
              >
                <div className="font-medium">{t.label}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Typical length: {t.typicalWeeks[0]}–{t.typicalWeeks[1]} weeks
                </div>
              </button>
            ))}
            <BackButton onClick={goBack} />
          </div>
        )}

        {step === 'days' && (
          <div className="space-y-3">
            {!showSplitPicker ? (
              <>
                <p className="text-sm text-muted-foreground mb-1">How should the new block's weekly structure be set?</p>
                <button
                  onClick={chooseMirror}
                  className="w-full text-left rounded-lg border border-primary/30 bg-primary/5 p-3 hover:bg-primary/10 transition-colors"
                >
                  <div className="font-medium">Match the source program's structure</div>
                  <div className="text-sm text-muted-foreground mt-0.5">
                    Keeps this athlete's training days and any full-body (SBD) days, with each lift's accessories.
                  </div>
                </button>
                <button
                  onClick={() => setShowSplitPicker(true)}
                  className="w-full text-left rounded-lg border p-3 hover:bg-accent transition-colors"
                >
                  <div className="font-medium">Use a standard split</div>
                  <div className="text-sm text-muted-foreground mt-0.5">
                    Lay the lifts out one per day across 3, 4 or 5 training days.
                  </div>
                </button>
                <BackButton onClick={goBack} />
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground mb-1">How many training days per week?</p>
                <div className="flex gap-2">
                  {TRAINING_DAY_OPTIONS.map((d) => (
                    <button
                      key={d}
                      onClick={() => pickDays(d)}
                      className="flex-1 rounded-lg border py-4 text-center font-semibold text-lg hover:bg-accent transition-colors"
                    >
                      {d}
                      <div className="text-xs font-normal text-muted-foreground mt-0.5">days/week</div>
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setShowSplitPicker(false)}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mt-1"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  Back to structure options
                </button>
              </>
            )}
          </div>
        )}

        {step === 'options' && template && (
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
                  <button type="button" onClick={toggleStyle} className="text-xs text-muted-foreground underline shrink-0">
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
                  <button type="button" onClick={toggleStyle} className="text-xs text-muted-foreground underline shrink-0">
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

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex gap-2 pt-1">
              <BackButton onClick={goBack} />
              <Button
                className="flex-1"
                onClick={handleGenerate}
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
        )}
      </DialogContent>
    </Dialog>
  )
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mt-1"
    >
      <ChevronLeft className="h-3.5 w-3.5" />
      Back
    </button>
  )
}
