import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardContent } from './ui/card'
import { Button } from './ui/button'
import { UserPlus, Mail, FileUp, Sparkles, Repeat, Check, RotateCcw, MessageSquare } from 'lucide-react'

// Guided first-run walkthrough shown on the dashboard. Each step that needs an
// action drops the coach straight onto the right screen; the explain-only steps
// make the training loop (import → style learned → smarter suggestions) visible
// rather than something the coach has to discover. The checklist is interactive:
// every step can be marked done or skipped, progress persists in localStorage,
// and finishing (or skipping all) hides it for good.
interface Step {
  id: string
  icon: typeof UserPlus
  title: string
  body: string
  optional?: boolean
  auto?: boolean // completion is detected automatically (the coach has an athlete)
  action?: { label: string; to: string }
}

const STEPS: Step[] = [
  {
    id: 'athlete',
    icon: UserPlus,
    title: 'Add your first athlete',
    body: 'Create an athlete to hold their maxes, programs and payment history.',
    auto: true,
    action: { label: 'Add athlete', to: '/athletes/new' },
  },
  {
    id: 'email',
    icon: Mail,
    title: 'Connect your email',
    optional: true,
    body: 'Optional. Send programs straight to your athletes from inside CoachBoard instead of saving the file and attaching it yourself. This is the only feature that needs an internet connection — everything else works fully offline. One-time setup with your own email; we walk you through every click.',
    action: { label: 'Set up email', to: '/settings' },
  },
  {
    id: 'discord',
    icon: MessageSquare,
    title: 'Connect Discord',
    optional: true,
    body: "Optional. If your athletes send form-check videos in Discord, CoachBoard pulls them in automatically, files them by athlete and training day, and lets you reply — video and DM — without leaving the app. A short guided setup walks you through every click; the one step that matters (turning on Message Content Intent) is called out so it can't be missed.",
    action: { label: 'Set up Discord', to: '/settings' },
  },
  {
    id: 'import',
    icon: FileUp,
    title: 'Import your existing programs',
    body: 'Drop in your past Excel programs to build your library in one afternoon instead of waiting months for it to accumulate.',
    action: { label: 'Import programs', to: '/programs?import=1' },
  },
  {
    id: 'style',
    icon: Sparkles,
    title: 'CoachBoard learns your style',
    body: "Those imports teach it your rep ranges, block lengths and RPE arcs — watch the “My Style” card fill in, so suggestions feel like your programming, not a generic template.",
  },
  {
    id: 'loop',
    icon: Repeat,
    title: 'Generate the next block',
    body: 'Email a program to your athlete → they fill in Load Used + Last Set RPE → import it back → CoachBoard drafts the next block, every weight explained and always yours to override.',
  },
]

// Bumped to v2 when the Discord step was added so coaches who finished the
// earlier checklist see it again (with the new optional step).
const STORAGE_KEY = 'coachboard.onboarding.v2'

interface Persisted {
  completed: string[]
  skipped: string[]
  done: boolean
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<Persisted>
      return {
        completed: Array.isArray(p.completed) ? p.completed : [],
        skipped: Array.isArray(p.skipped) ? p.skipped : [],
        done: !!p.done,
      }
    }
  } catch {
    /* ignore corrupt storage */
  }
  return { completed: [], skipped: [], done: false }
}

function save(p: Persisted) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch {
    /* ignore */
  }
}

/** Whether the coach has finished (or dismissed) onboarding — drives the dashboard. */
export function isOnboardingComplete(): boolean {
  return load().done
}

interface Props {
  athleteCount: number
  onFinish: () => void
}

export default function Onboarding({ athleteCount, onFinish }: Props) {
  const [completed, setCompleted] = useState<Set<string>>(() => new Set(load().completed))
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set(load().skipped))

  // Persist progress as the coach checks steps off.
  useEffect(() => {
    save({ completed: [...completed], skipped: [...skipped], done: false })
  }, [completed, skipped])

  // The first step completes itself once the coach actually has an athlete.
  useEffect(() => {
    if (athleteCount > 0 && !completed.has('athlete')) {
      setCompleted((c) => new Set(c).add('athlete'))
    }
  }, [athleteCount, completed])

  const isCompleted = (id: string) => completed.has(id)
  const isSkipped = (id: string) => skipped.has(id)
  const isResolved = (id: string) => isCompleted(id) || isSkipped(id)
  const doneCount = STEPS.filter((s) => isCompleted(s.id)).length
  const allResolved = STEPS.every((s) => isResolved(s.id))

  const markDone = (id: string) => {
    setSkipped((s) => { const n = new Set(s); n.delete(id); return n })
    setCompleted((c) => new Set(c).add(id))
  }
  const skip = (id: string) => {
    setCompleted((c) => { const n = new Set(c); n.delete(id); return n })
    setSkipped((s) => new Set(s).add(id))
  }
  const undo = (id: string) => {
    setCompleted((c) => { const n = new Set(c); n.delete(id); return n })
    setSkipped((s) => { const n = new Set(s); n.delete(id); return n })
  }

  const finish = () => {
    save({ completed: [...completed], skipped: [...skipped], done: true })
    onFinish()
  }
  const skipAll = () => {
    const nextSkipped = new Set(skipped)
    STEPS.forEach((s) => { if (!isCompleted(s.id)) nextSkipped.add(s.id) })
    save({ completed: [...completed], skipped: [...nextSkipped], done: true })
    onFinish()
  }

  return (
    <Card>
      <CardContent className="py-8 px-6">
        <div className="text-center mb-6">
          <h2 className="text-xl font-semibold">Welcome to CoachBoard</h2>
          <p className="text-muted-foreground mt-1">
            A few steps to set up the training loop. Mark each one done — or skip the ones you don't need.
          </p>
        </div>

        <div className="max-w-2xl mx-auto mb-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-1.5 w-32 rounded-full bg-muted overflow-hidden shrink-0">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${(doneCount / STEPS.length) * 100}%` }}
              />
            </div>
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              {doneCount} of {STEPS.length} done
            </span>
          </div>
          {allResolved ? (
            <Button size="sm" onClick={finish}>Finish</Button>
          ) : (
            <button
              type="button"
              onClick={skipAll}
              className="text-sm text-muted-foreground underline whitespace-nowrap"
            >
              Skip all
            </button>
          )}
        </div>

        <ol className="space-y-4 max-w-2xl mx-auto">
          {STEPS.map(({ id, icon: Icon, title, body, optional, auto, action }, i) => {
            const completedStep = isCompleted(id)
            const skippedStep = isSkipped(id)
            // The auto step can't be undone while the athlete still exists.
            const lockUndo = !!auto && athleteCount > 0
            return (
              <li
                key={id}
                className={`flex gap-4 rounded-lg border p-4 transition-opacity ${skippedStep ? 'opacity-60' : ''}`}
              >
                <div className="flex flex-col items-center">
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-semibold text-sm ${
                      completedStep
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-primary/10 text-primary'
                    }`}
                  >
                    {completedStep ? <Check className="h-4 w-4" /> : i + 1}
                  </div>
                  {i < STEPS.length - 1 && <div className="mt-1 w-px flex-1 bg-border" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 font-medium">
                    <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className={completedStep ? 'line-through text-muted-foreground' : ''}>{title}</span>
                    {optional && (
                      <span className="rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        Optional
                      </span>
                    )}
                    {skippedStep && (
                      <span className="rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        Skipped
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">{body}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {completedStep || skippedStep ? (
                      !lockUndo && (
                        <Button size="sm" variant="ghost" onClick={() => undo(id)}>
                          <RotateCcw className="h-3.5 w-3.5 mr-1" />Undo
                        </Button>
                      )
                    ) : (
                      <>
                        {action && (
                          <Link to={action.to}>
                            <Button size="sm">{action.label}</Button>
                          </Link>
                        )}
                        <Button size="sm" variant="outline" onClick={() => markDone(id)}>
                          <Check className="h-3.5 w-3.5 mr-1" />Mark done
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => skip(id)}>
                          Skip
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      </CardContent>
    </Card>
  )
}
