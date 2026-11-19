import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardContent } from './ui/card'
import { Button } from './ui/button'
import { UserPlus, Mail, FileUp, Check, RotateCcw, MessageSquare } from 'lucide-react'
import { saveTour, type TourStatus } from '../tour/tourApi'

// The setup checklist on the dashboard: the four things to do to set
// CoachBoard up for real (D17). Each drops the coach on the right screen. The
// two explain-only steps it used to have — the style being learned and the
// next block being drafted — are stops in the first-start tour now. Every step
// can be marked done or skipped; finishing, or skipping all, puts it away, and
// Settings → Help brings it back. Progress is kept with the app's data (T8),
// so a restore does not reset it.
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
]

/** Where the checklist used to be kept, in the browser, before T8. Read once to carry it over. */
const LEGACY_KEY = 'coachboard.onboarding.v2'

type Checklist = TourStatus['checklist']

/**
 * The checklist as stored with the app's data — or, the first time, as the
 * browser had it before (T8), so nobody's ticks are lost in the move. Returns
 * whether the old copy should be written over.
 */
export function checklistFrom(status: TourStatus): { checklist: Checklist; migrate: boolean } {
  const stored = status.checklist
  const untouched = !stored.done && stored.completed.length === 0 && stored.skipped.length === 0
  if (!untouched) return { checklist: stored, migrate: false }
  try {
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) return { checklist: stored, migrate: false }
    const p = JSON.parse(raw) as Partial<Checklist>
    const ids = new Set(STEPS.map((s) => s.id))
    const keep = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string' && ids.has(x)) : [])
    return { checklist: { completed: keep(p.completed), skipped: keep(p.skipped), done: !!p.done }, migrate: true }
  } catch {
    return { checklist: stored, migrate: false }
  }
}

interface Props {
  athleteCount: number
  initial: Checklist
  onFinish: () => void
}

export default function Onboarding({ athleteCount, initial, onFinish }: Props) {
  const [completed, setCompleted] = useState<Set<string>>(() => new Set(initial.completed))
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set(initial.skipped))
  const first = useRef(true)

  // Kept as the coach checks steps off.
  useEffect(() => {
    if (first.current) { first.current = false; return }
    void saveTour({ checklist: { completed: [...completed], skipped: [...skipped], done: false } }).catch(() => {})
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
    void saveTour({ checklist: { completed: [...completed], skipped: [...skipped], done: true } }).catch(() => {})
    onFinish()
  }
  const skipAll = () => {
    const nextSkipped = new Set(skipped)
    STEPS.forEach((s) => { if (!isCompleted(s.id)) nextSkipped.add(s.id) })
    void saveTour({ checklist: { completed: [...completed], skipped: [...nextSkipped], done: true } }).catch(() => {})
    onFinish()
  }

  return (
    <Card>
      <CardContent className="py-8 px-6">
        <div className="text-center mb-6">
          <h2 className="text-xl font-semibold">Set up CoachBoard</h2>
          <p className="text-muted-foreground mt-1">
            Four things to get going with your own athletes. Mark each one done — or skip the ones you
            don't need. Settings → Help brings this back.
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
