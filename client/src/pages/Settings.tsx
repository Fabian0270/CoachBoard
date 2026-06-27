import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../components/ui/select'
import { useToast } from '../components/ui/toast'
import { Mail, Send, ExternalLink, AlertTriangle } from 'lucide-react'

type Provider = 'gmail' | 'outlook' | 'custom'

interface ProviderPreset {
  label: string
  host: string
  port: number
  secure: boolean
  /** Direct link to the provider's app-password page, when it has one. */
  appPasswordUrl?: string
  warning?: string
}

const GMAIL_TWO_STEP_URL = 'https://myaccount.google.com/signinoptions/two-step-verification'
const GMAIL_APP_PASSWORD_URL = 'https://myaccount.google.com/apppasswords'

const PRESETS: Record<Provider, ProviderPreset> = {
  gmail: {
    label: 'Gmail',
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    appPasswordUrl: GMAIL_APP_PASSWORD_URL,
  },
  outlook: {
    label: 'Outlook / Microsoft 365',
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    warning:
      'Microsoft is disabling basic SMTP sign-in on many Outlook / Microsoft 365 accounts, so an app password may not work here. If sending fails, use a Gmail account for now.',
  },
  custom: { label: 'Other (enter SMTP details)', host: '', port: 587, secure: false },
}

interface PublicEmailSettings {
  configured: boolean
  provider?: Provider
  host?: string
  port?: number
  secure?: boolean
  user?: string
  fromName?: string
}

export default function Settings() {
  const toast = useToast()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const [configured, setConfigured] = useState(false)
  const [provider, setProvider] = useState<Provider>('gmail')
  const [host, setHost] = useState(PRESETS.gmail.host)
  const [port, setPort] = useState<number>(PRESETS.gmail.port)
  const [secure, setSecure] = useState(PRESETS.gmail.secure)
  const [user, setUser] = useState('')
  const [fromName, setFromName] = useState('')
  const [password, setPassword] = useState('')

  useEffect(() => {
    fetch('/api/settings/email')
      .then((r) => r.json())
      .then((s: PublicEmailSettings) => {
        if (s && s.configured) {
          setConfigured(true)
          if (s.provider) setProvider(s.provider)
          if (s.host) setHost(s.host)
          if (typeof s.port === 'number') setPort(s.port)
          if (typeof s.secure === 'boolean') setSecure(s.secure)
          if (s.user) setUser(s.user)
          if (s.fromName) setFromName(s.fromName)
        }
      })
      .catch(() => { /* leave defaults */ })
      .finally(() => setLoading(false))
  }, [])

  const preset = PRESETS[provider]
  const isCustom = provider === 'custom'

  const onProviderChange = (value: string) => {
    const p = value as Provider
    setProvider(p)
    // Auto-fill host/port/secure from the preset (the coach only enters email + password).
    setHost(PRESETS[p].host)
    setPort(PRESETS[p].port)
    setSecure(PRESETS[p].secure)
  }

  const buildPayload = () => ({
    provider,
    host,
    port,
    secure,
    user: user.trim(),
    fromName: fromName.trim(),
    // Only send a password when the coach typed one; empty keeps the saved one.
    ...(password ? { password } : {}),
  })

  const save = async (): Promise<boolean> => {
    if (!user.trim()) { toast.error('Enter your email address'); return false }
    if (!configured && !password) { toast.error('Enter your app password'); return false }
    setSaving(true)
    try {
      const res = await fetch('/api/settings/email', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload()),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(data.error ?? 'Failed to save email settings'); return false }
      setConfigured(true)
      setPassword('')
      toast.success('Email settings saved')
      return true
    } finally {
      setSaving(false)
    }
  }

  const sendTest = async () => {
    setTesting(true)
    try {
      // Save first so the test uses the latest values.
      if (!(await save())) return
      const res = await fetch('/api/settings/email/test', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (res.ok) toast.success(`Test email sent to ${user.trim()} — check your inbox`)
      else toast.error(data.error ?? 'Failed to send test email')
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <Mail className="h-6 w-6 text-muted-foreground" />
        <h1 className="text-3xl font-bold">Settings</h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Email delivery</CardTitle>
          <CardDescription>
            Send programs straight to your athletes by email. CoachBoard sends through your own email
            account — your app password is encrypted and stored only on this computer, never online.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {configured && (
            <p className="text-sm text-emerald-600 dark:text-emerald-400">
              ✓ Email is set up. You can update it below.
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="provider">Email provider</Label>
            <Select value={provider} onValueChange={onProviderChange}>
              <SelectTrigger id="provider"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="gmail">{PRESETS.gmail.label}</SelectItem>
                <SelectItem value="outlook">{PRESETS.outlook.label}</SelectItem>
                <SelectItem value="custom">{PRESETS.custom.label}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {preset.warning && (
            <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{preset.warning}</span>
            </div>
          )}

          {provider === 'gmail' && <GmailGuide />}

          <div className="space-y-1.5">
            <Label htmlFor="user">{provider === 'gmail' ? 'Your Gmail address' : 'Your email address'}</Label>
            <Input
              id="user" type="email" value={user} placeholder="you@gmail.com"
              onChange={(e) => setUser(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">App password</Label>
            <Input
              id="password" type="password" value={password}
              placeholder={configured ? '•••••••• (saved — leave blank to keep)' : 'Paste the 16-character code here'}
              onChange={(e) => setPassword(e.target.value)}
            />
            {provider === 'gmail' && !configured && (
              <p className="text-xs text-muted-foreground">
                This is the code from step 2 — <strong>not</strong> your normal Gmail password. Spaces are fine.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="fromName">Sender name <span className="text-muted-foreground">(optional)</span></Label>
            <Input
              id="fromName" value={fromName} placeholder="e.g. Coach Fabian"
              onChange={(e) => setFromName(e.target.value)}
            />
          </div>

          {isCustom && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5 col-span-2">
                <Label htmlFor="host">SMTP host</Label>
                <Input id="host" value={host} placeholder="smtp.example.com" onChange={(e) => setHost(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="port">Port</Label>
                <Input
                  id="port" type="number" value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="secure">Connection</Label>
                <Select value={secure ? 'ssl' : 'starttls'} onValueChange={(v) => setSecure(v === 'ssl')}>
                  <SelectTrigger id="secure"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ssl">SSL/TLS (port 465)</SelectItem>
                    <SelectItem value="starttls">STARTTLS (port 587)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            <Button onClick={save} disabled={saving || testing}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="outline" onClick={sendTest} disabled={saving || testing}>
              <Send className="h-4 w-4" />
              {testing ? 'Sending…' : 'Send test email'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

/** Opens an external URL in the system browser (Electron routes target=_blank via shell.openExternal). */
function OpenLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href} target="_blank" rel="noreferrer"
      className="mt-1 inline-flex items-center gap-1 rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
    >
      {children} <ExternalLink className="h-3 w-3" />
    </a>
  )
}

/** Click-by-click walkthrough for getting a Gmail app password — the one genuinely confusing step. */
function GmailGuide() {
  const steps: { text: React.ReactNode; link?: { href: string; label: string } }[] = [
    {
      text: <>Turn on <strong>2-Step Verification</strong> for your Google account (skip if it’s already on — app passwords need it).</>,
      link: { href: GMAIL_TWO_STEP_URL, label: 'Open 2-Step Verification' },
    },
    {
      text: <>Open Google’s <strong>App passwords</strong> page, type <code className="rounded bg-background px-1">CoachBoard</code> as the name, and click <strong>Create</strong>.</>,
      link: { href: GMAIL_APP_PASSWORD_URL, label: 'Open App passwords' },
    },
    {
      text: <>Google shows a <strong>16-character code</strong>. Copy it and paste it into <strong>App password</strong> below — then enter your Gmail address and click <strong>Send test email</strong>.</>,
    },
  ]
  return (
    <div className="rounded-md border bg-muted/40 p-4">
      <p className="text-sm font-medium">Connect Gmail in 3 steps</p>
      <ol className="mt-3 space-y-3">
        {steps.map((s, i) => (
          <li key={i} className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              {i + 1}
            </span>
            <div className="flex-1 text-sm text-muted-foreground">
              {s.text}
              {s.link && <div><OpenLink href={s.link.href}>{s.link.label}</OpenLink></div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
