import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { PaymentAlert } from 'coachboard-shared'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Users, Dumbbell, Plus, AlertTriangle, HardDrive } from 'lucide-react'
import MyStyleCard from '../components/MyStyleCard'
import Onboarding, { isOnboardingComplete } from '../components/Onboarding'
import { PAYMENT_STATUS_META, formatAmount } from '../lib/paymentDisplay'
import { humanBytes } from '../lib/formatBytes'
import { useDiscordConfigured } from '../hooks/useDiscordConfigured'

interface Stats {
  athletes: number
  programs: number
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats>({ athletes: 0, programs: 0 })
  const [paymentAlerts, setPaymentAlerts] = useState<PaymentAlert[]>([])
  const [onboardingDone, setOnboardingDone] = useState(isOnboardingComplete())
  const { configured: discordConfigured } = useDiscordConfigured()
  const [storage, setStorage] = useState<{ bytes: number; files: number } | null>(null)

  useEffect(() => {
    Promise.all([
      fetch('/api/athletes').then((r) => r.json()).catch(() => []),
      fetch('/api/programs').then((r) => r.json()).catch(() => []),
    ]).then(([athletes, programs]) => {
      setStats({
        athletes: Array.isArray(athletes) ? athletes.length : 0,
        programs: Array.isArray(programs) ? programs.length : 0,
      })
    }).catch(() => {})

    fetch('/api/payments/alerts')
      .then((r) => r.json())
      .then((data) => setPaymentAlerts(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!discordConfigured) {
      setStorage(null)
      return
    }
    fetch('/api/discord/media/storage')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => setStorage(s))
      .catch(() => {})
  }, [discordConfigured])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <Link to="/athletes/new">
          <Button><Plus className="h-4 w-4 mr-2" />Add Athlete</Button>
        </Link>
      </div>
      {paymentAlerts.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Payment reminders ({paymentAlerts.length})
            </CardTitle>
            <Link to="/payments" className="text-xs text-muted-foreground underline">View all</Link>
          </CardHeader>
          <CardContent className="space-y-1">
            {paymentAlerts.map((a) => {
              const meta = PAYMENT_STATUS_META[a.status]
              return (
                <div key={a.payment.id} className="flex items-center gap-2 flex-wrap text-sm">
                  <Link to={`/athletes/${a.athleteId}`} className="font-medium hover:underline">{a.athleteName}</Link>
                  <Badge variant={meta.variant}>{meta.label}</Badge>
                  <span className="text-muted-foreground">
                    {formatAmount(a.payment.amount, a.payment.currency)} ·{' '}
                    {a.status === 'expiring_soon' ? 'paid through' : 'due by'} {a.payment.paid_through}
                  </span>
                </div>
              )
            })}
          </CardContent>
        </Card>
      )}

      <div className={`grid grid-cols-1 gap-4 ${storage ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Athletes</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.athletes}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Training Programs</CardTitle>
            <Dumbbell className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.programs}</div>
          </CardContent>
        </Card>
        {storage && (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium">Video storage used</CardTitle>
              <HardDrive className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{humanBytes(storage.bytes)}</div>
              <p className="text-xs text-muted-foreground">
                {storage.files} file{storage.files === 1 ? '' : 's'} from Discord
              </p>
            </CardContent>
          </Card>
        )}
      </div>
      {/* Guided onboarding until the coach finishes (or skips) it; the style card after. */}
      {onboardingDone
        ? <MyStyleCard />
        : <Onboarding athleteCount={stats.athletes} onFinish={() => setOnboardingDone(true)} />}
    </div>
  )
}
