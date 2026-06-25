import { Link } from 'react-router-dom'
import { Card, CardContent } from './ui/card'
import { Button } from './ui/button'
import { UserPlus, FileUp, Sparkles, Repeat } from 'lucide-react'

// Guided first-run walkthrough shown on the dashboard while the coach has no
// athletes yet. The first two steps are concrete actions; the last two explain
// the training loop so the chain (import → style learned → smarter suggestions)
// is visible rather than something the coach has to discover. Email delivery
// (Feature 6) is intentionally omitted until it ships.
interface Step {
  icon: typeof UserPlus
  title: string
  body: string
  action?: { label: string; to: string }
}

const STEPS: Step[] = [
  {
    icon: UserPlus,
    title: 'Add your first athlete',
    body: 'Create an athlete to hold their maxes, programs and payment history.',
    action: { label: 'Add athlete', to: '/athletes/new' },
  },
  {
    icon: FileUp,
    title: 'Import your existing programs',
    body: 'Drop in your past Excel programs to build your library in one afternoon instead of waiting months for it to accumulate.',
    action: { label: 'Import programs', to: '/programs?import=1' },
  },
  {
    icon: Sparkles,
    title: 'CoachBoard learns your style',
    body: "Those imports teach it your rep ranges, block lengths and RPE arcs — watch the “My Style” card fill in, so suggestions feel like your programming, not a generic template.",
  },
  {
    icon: Repeat,
    title: 'Generate the next block',
    body: 'Export a program → your athlete fills in Load Used + Last Set RPE → import it back → CoachBoard drafts the next block, every weight explained and always yours to override.',
  },
] as const

export default function Onboarding() {
  return (
    <Card>
      <CardContent className="py-8 px-6">
        <div className="text-center mb-8">
          <h2 className="text-xl font-semibold">Welcome to CoachBoard</h2>
          <p className="text-muted-foreground mt-1">
            Four steps to set up the training loop. Start at the top.
          </p>
        </div>

        <ol className="space-y-4 max-w-2xl mx-auto">
          {STEPS.map(({ icon: Icon, title, body, action }, i) => (
            <li key={title} className="flex gap-4 rounded-lg border p-4">
              <div className="flex flex-col items-center">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary font-semibold text-sm">
                  {i + 1}
                </div>
                {i < STEPS.length - 1 && <div className="mt-1 w-px flex-1 bg-border" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 font-medium">
                  <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                  {title}
                </div>
                <p className="text-sm text-muted-foreground mt-1">{body}</p>
                {action && (
                  <Link to={action.to} className="inline-block mt-3">
                    <Button size="sm">{action.label}</Button>
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}
