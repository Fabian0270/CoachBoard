import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { AttentionItem, PaymentAlert } from 'coachboard-shared'
import { localToday } from '../lib/dates'
import { useDiscordInboxCounts } from '../hooks/useDiscordInboxCounts'
import { getJson, getList, errorMessage } from '../lib/api'
import LoadError from '../components/LoadError'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import PageHeader from '../components/PageHeader'
import { Plus, AlertTriangle, ArrowUpRight, CalendarClock, UserX, Film, Gauge } from 'lucide-react'
import { isVbtLift, liftLabel } from 'coachboard-shared/vbt'
import MyStyleCard from '../components/MyStyleCard'
import Onboarding, { checklistFrom } from '../components/Onboarding'
import { getTourStatus, saveTour, type TourStatus } from '../tour/tourApi'
import { PAYMENT_STATUS_META, formatAmount } from '../lib/paymentDisplay'
import { humanBytes } from '../lib/formatBytes'
import { useDiscordConfigured } from '../hooks/useDiscordConfigured'

function StatFigure({ to, label, value, note }: { to: string; label: string; value: string | number; note: string }) {
  return (
    <Link to={to} className="group relative block px-6 py-5 transition-colors duration-150 ease-smooth hover:bg-foreground/[0.03]">
      <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
        <ArrowUpRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <div className="num mt-3 text-[40px] font-medium leading-none tracking-tight">{value}</div>
      <div className="mt-2 text-xs text-muted-foreground">{note}</div>
    </Link>
  )
}

/** "Sun 22 Nov" */
const shortDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

const SHOWN = 8

/**
 * What the coach should act on (I2): blocks ending with nothing after them,
 * imports that have not come in, athletes without a program, and videos
 * waiting in the inbox. Payments keep their own card below.
 */
function AttentionCard({ unreviewedVideos }: { unreviewedVideos: number }) {
  const [items, setItems] = useState<AttentionItem[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const load = useCallback(async () => {
    setFailed(null)
    try {
      setItems(await getList<AttentionItem>(`/api/dashboard/attention?today=${localToday()}`))
    } catch (err) {
      // Never "all caught up" on a failed check: that would say nothing is wrong.
      setItems(null)
      setFailed(errorMessage(err))
    }
  }, [])
  useEffect(() => { void load() }, [load])

  if (failed) {
    return (
      <section className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-5 py-3 text-sm">
        <AlertTriangle className="h-4 w-4 text-warning" />
        <span>Could not check what needs your attention. {failed}</span>
        <Button size="sm" variant="outline" onClick={() => void load()}>Try again</Button>
      </section>
    )
  }
  if (!items) return null

  const today = localToday()
  const lines = [
    ...(unreviewedVideos > 0 ? [{
      key: 'videos',
      icon: <Film className="h-4 w-4 text-primary" />,
      body: <Link to="/discord-inbox" className="font-medium hover:text-primary">{unreviewedVideos} video{unreviewedVideos === 1 ? '' : 's'} to review</Link>,
    }] : []),
    ...items.map((item) => {
      const athlete = <Link to={`/athletes/${item.athleteId}`} className="font-medium hover:text-primary">{item.athleteName}</Link>
      const program = item.programId && <Link to={`/programs/${item.programId}`} className="hover:text-primary">{item.programName}</Link>
      if (item.kind === 'block-ending') {
        return {
          key: `end:${item.programId}`,
          icon: <CalendarClock className="h-4 w-4 text-warning" />,
          body: <>{athlete} · {program} {item.date! < today ? 'ended' : 'ends'} <span className="num">{shortDay(item.date!)}</span> <span className="text-muted-foreground">— no next block yet</span></>,
        }
      }
      if (item.kind === 'slow-session') {
        // BP33, D59: a session that read well under the athlete's usual max.
        return {
          key: `slow:${item.athleteId}:${item.lift}:${item.date}`,
          icon: <Gauge className="h-4 w-4 text-warning" />,
          body: <>{athlete}&rsquo;s {isVbtLift(item.lift) ? liftLabel(item.lift).toLowerCase() : 'lift'} read <span className="num">{Math.round((item.under ?? 0) * 100)} %</span> under the usual on <span className="num">{shortDay(item.date!)}</span> <span className="text-muted-foreground">— from the bar path sets that day</span></>,
        }
      }
      return {
        key: `none:${item.athleteId}`,
        icon: <UserX className="h-4 w-4 text-muted-foreground" />,
        body: <>{athlete} <span className="text-muted-foreground">has no active program</span></>,
      }
    }),
  ]

  return (
    <section className="rounded-lg border bg-card" aria-labelledby="attention-title" data-tour="dashboard-attention">
      <div className="flex items-center gap-2 px-5 pb-2 pt-4">
        <h2 id="attention-title" className="text-sm font-semibold">Needs attention</h2>
        {lines.length > 0 && <span className="num rounded-full bg-warning/15 px-1.5 text-[11px] text-warning">{lines.length}</span>}
      </div>
      {lines.length === 0 ? (
        <p className="px-5 pb-4 text-sm text-muted-foreground">Nothing needs your attention right now.</p>
      ) : (
        <ul className="divide-y px-5 pb-2">
          {(showAll ? lines : lines.slice(0, SHOWN)).map((l) => (
            <li key={l.key} className="flex items-center gap-2.5 py-2 text-sm">{l.icon}<span>{l.body}</span></li>
          ))}
          {lines.length > SHOWN && (
            <li className="py-2">
              <button type="button" onClick={() => setShowAll((v) => !v)} className="text-xs font-medium text-muted-foreground hover:text-foreground">
                {showAll ? 'Show fewer' : `Show all ${lines.length}`}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}

interface Stats {
  athletes: number
  programs: number
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats>({ athletes: 0, programs: 0 })
  const [paymentAlerts, setPaymentAlerts] = useState<PaymentAlert[]>([])
  /** The setup checklist as kept with the app's data (T8); null until read, so it never flashes. */
  const [checklist, setChecklist] = useState<TourStatus['checklist'] | null>(null)
  useEffect(() => {
    getTourStatus().then((s) => {
      const { checklist: c, migrate } = checklistFrom(s)
      // Carried over once from where the browser kept it before.
      if (migrate) void saveTour({ checklist: c }).catch(() => {})
      setChecklist(c)
    }, () => setChecklist({ completed: [], skipped: [], done: true }))
  }, [])
  const onboardingDone = checklist?.done ?? true
  const setOnboardingDone = (done: boolean) => setChecklist((c) => (c ? { ...c, done } : c))
  const { configured: discordConfigured } = useDiscordConfigured()
  const inbox = useDiscordInboxCounts()
  const [storage, setStorage] = useState<{ bytes: number; files: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [athletes, programs, alerts] = await Promise.all([
        getList<{ id: string; is_sample?: number }>('/api/athletes'),
        getList<{ athlete_id: string | null }>('/api/programs'),
        getList<PaymentAlert>('/api/payments/alerts'),
      ])
      // The tour's sample athlete is not part of the coach's business (T7).
      const sample = new Set(athletes.filter((a) => a.is_sample).map((a) => a.id))
      setStats({
        athletes: athletes.length - sample.size,
        programs: programs.filter((p) => !p.athlete_id || !sample.has(p.athlete_id)).length,
      })
      setPaymentAlerts(alerts)
    } catch (err) {
      // Previously every one of these swallowed its failure and left the tiles
      // reading zero — which on a local-first app looks exactly like the
      // database having been wiped, with nothing on screen to say otherwise.
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!discordConfigured) {
      setStorage(null)
      return
    }
    // The storage tile is extra detail. On failure it is hidden; showing 0 B
    // would claim the media folder is empty.
    let cancelled = false
    getJson<{ bytes: number; files: number }>('/api/discord/media/storage')
      .then((s) => { if (!cancelled) setStorage(s) })
      .catch(() => { if (!cancelled) setStorage(null) })
    return () => { cancelled = true }
  }, [discordConfigured])

  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <PageHeader
        eyebrow={today}
        title="Dashboard"
        actions={
          <Link to="/athletes/new">
            <Button><Plus className="h-4 w-4" />Add Athlete</Button>
          </Link>
        }
      />

      {!error && <AttentionCard unreviewedVideos={discordConfigured ? inbox.unreviewed : 0} />}

      {paymentAlerts.length > 0 && (
        <section className="relative overflow-hidden rounded-lg border border-destructive/30 bg-card">
          <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-destructive" />
          <div className="flex items-center justify-between gap-4 px-5 pb-2 pt-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Payment reminders
              <span className="num rounded-full bg-destructive/10 px-1.5 text-[11px] text-destructive">{paymentAlerts.length}</span>
            </h2>
            <Link to="/payments" className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
              View all →
            </Link>
          </div>
          <ul className="divide-y px-5 pb-2">
            {paymentAlerts.map((a) => {
              const meta = PAYMENT_STATUS_META[a.status]
              return (
                <li key={a.payment.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                  <Link to={`/athletes/${a.athleteId}`} className="font-medium hover:text-primary">{a.athleteName}</Link>
                  <Badge variant={meta.variant}>{meta.label}</Badge>
                  <span className="ml-auto text-muted-foreground">
                    <span className="num text-foreground">{formatAmount(a.payment.amount, a.payment.currency)}</span>
                    {' · '}
                    {a.status === 'expiring_soon' ? 'paid through' : 'due by'} <span className="num">{a.payment.paid_through}</span>
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {/* Replaces the figures rather than sitting above them. Showing "Athletes
          0" next to an error message is still telling the coach their roster
          is empty — the number has to go, not just be explained. */}
      {error ? (
        <LoadError what="your dashboard" message={error} onRetry={() => void load()} />
      ) : (
      <>
      {/* One strip of figures, split by hairlines, instead of a row of
          identical icon tiles. Each figure links to the screen it counts. */}
      <section
        className={`grid grid-cols-1 overflow-hidden rounded-xl border bg-card bg-glow-hero divide-y sm:divide-x sm:divide-y-0 ${storage ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}
      >
        <StatFigure to="/athletes" label="Athletes" value={stats.athletes} note="on your roster" />
        <StatFigure to="/programs" label="Training programs" value={stats.programs} note="across all athletes" />
        {storage && (
          <StatFigure
            to="/discord-inbox"
            label="Video storage"
            value={humanBytes(storage.bytes)}
            note={`${storage.files} file${storage.files === 1 ? '' : 's'} from Discord`}
          />
        )}
      </section>
      {/* Guided onboarding until the coach finishes (or skips) it; the style card
          after. Inside the non-error branch because it keys off athleteCount:
          a failed load would otherwise show an established coach the
          "add your first athlete" walkthrough. */}
      {checklist === null ? null : onboardingDone
        ? <MyStyleCard />
        : <Onboarding athleteCount={stats.athletes} initial={checklist} onFinish={() => setOnboardingDone(true)} />}
      </>
      )}
    </div>
  )
}
