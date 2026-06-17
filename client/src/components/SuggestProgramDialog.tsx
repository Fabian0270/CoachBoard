import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Loader2, ChevronLeft, Sparkles } from 'lucide-react'
import { SUGGESTION_TEMPLATES } from 'coachboard-shared'
import type { SuggestionGoal, SuggestionTemplateInfo } from 'coachboard-shared'

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
  const [weeks, setWeeks] = useState(4)
  const [startDate, setStartDate] = useState(todayIso)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
        setSourcePrograms(all.filter((p) => p.status === 'completed'))
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
    setWeeks(4)
    setStartDate(todayIso())
    setLoading(false)
    setError(null)
  }

  function handleOpenChange(v: boolean) {
    if (!v) reset()
    onOpenChange(v)
  }

  function goBack() {
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
    setGoal(g)
    setTemplate(null)
    setStep('variant')
  }

  function pickVariant(t: SuggestionTemplateInfo) {
    setTemplate(t)
    setWeeks(t.typicalWeeks[0])
    setStep('days')
  }

  function pickDays(d: 3 | 4 | 5) {
    setTrainingDays(d)
    setStep('options')
  }

  async function handleGenerate() {
    if (!template || !startDate) return
    const effectiveProgramId = programId ?? pickedProgramId
    const effectiveAthleteId = athleteId ?? pickedAthleteId
    if (!effectiveProgramId || !effectiveAthleteId) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/programs/${effectiveProgramId}/suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athleteId: effectiveAthleteId,
          templateId: template.id,
          weeks,
          trainingDaysPerWeek: trainingDays,
          startDate,
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
            <p className="text-sm text-muted-foreground mb-3">Which completed program should the new block be based on?</p>
            {sourcesLoading && <p className="text-sm text-muted-foreground">Loading programs…</p>}
            {sourcesError && <p className="text-sm text-destructive">{sourcesError}</p>}
            {sourcePrograms !== null && sourcePrograms.length === 0 && (
              <p className="text-sm text-muted-foreground">No completed programs found for this athlete.</p>
            )}
            {sourcePrograms?.map((p) => (
              <button
                key={p.id}
                onClick={() => pickSourceProgram(p)}
                className="w-full text-left rounded-lg border p-3 hover:bg-accent transition-colors"
              >
                <div className="font-medium">{p.name}</div>
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
            <BackButton onClick={goBack} />
          </div>
        )}

        {step === 'options' && template && (
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Template: </span>
              <span className="font-medium">{GOAL_LABELS[template.goal]} — {template.label}</span>
              <span className="text-muted-foreground"> · {trainingDays} days/week</span>
            </div>

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
