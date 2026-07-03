import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select'
import { cn } from '../../lib/utils'
import {
  ExternalLink, Loader2, CheckCircle2, AlertTriangle, Copy, PartyPopper,
} from 'lucide-react'
import type {
  PublicDiscordSettings, DiscordGuildDto, DiscordChannelOptionDto, SyncStatusDto,
  DiscordMediaItem,
} from 'coachboard-shared/discord'

const DEV_PORTAL_URL = 'https://discord.com/developers/applications'

type Step = 'create' | 'token' | 'invite' | 'channels' | 'sync'
const STEP_LIST: Step[] = ['create', 'token', 'invite', 'channels', 'sync']

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  onConnected: (settings: PublicDiscordSettings) => void
}

/**
 * Hand-holding setup wizard: one action per screen, the primary button stays
 * disabled until the step is verifiably done, and every failure says exactly
 * what to click in Discord to fix it. The token validates automatically on
 * paste; the invite step auto-advances the moment the bot joins a server.
 */
export default function DiscordSetupWizard({ open, onOpenChange, onConnected }: Props) {
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('create')
  const [settings, setSettings] = useState<PublicDiscordSettings | null>(null)
  const [guilds, setGuilds] = useState<DiscordGuildDto[] | null>(null)

  const reset = () => {
    setStep('create')
    setSettings(null)
    setGuilds(null)
  }

  const handleOpenChange = (v: boolean) => {
    if (!v) reset()
    onOpenChange(v)
  }

  const stepIdx = STEP_LIST.indexOf(step)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect Discord</DialogTitle>
        </DialogHeader>

        {/* Progress bar (SuggestProgramDialog pattern) */}
        <div className="flex gap-1">
          {STEP_LIST.map((s, i) => (
            <div
              key={s}
              className={cn('h-1 flex-1 rounded-full', i <= stepIdx ? 'bg-primary' : 'bg-muted')}
            />
          ))}
        </div>

        {step === 'create' && <CreateAppStep onNext={() => setStep('token')} />}
        {step === 'token' && (
          <TokenStep
            onBack={() => setStep('create')}
            onValidated={(s) => {
              setSettings(s)
              onConnected(s)
              setStep('invite')
            }}
          />
        )}
        {step === 'invite' && settings && (
          <InviteStep
            inviteUrl={settings.inviteUrl}
            onBack={() => setStep('token')}
            onJoined={(gs) => {
              setGuilds(gs)
              setStep('channels')
            }}
          />
        )}
        {step === 'channels' && (
          <ChannelStep
            guilds={guilds ?? []}
            onBack={() => setStep('invite')}
            onDone={() => setStep('sync')}
          />
        )}
        {step === 'sync' && (
          <FirstSyncStep
            onFinish={() => {
              handleOpenChange(false)
              navigate('/discord-inbox')
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function StepShell({
  title,
  children,
  footer,
}: {
  title: string
  children: React.ReactNode
  footer: React.ReactNode
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm font-medium">{title}</p>
      {children}
      <div className="flex justify-between gap-2 pt-2">{footer}</div>
    </div>
  )
}

function GuideLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href} target="_blank" rel="noreferrer"
      className="mt-1 inline-flex items-center gap-1 rounded-md border border-input bg-background px-2.5 py-1 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
    >
      {children} <ExternalLink className="h-3 w-3" />
    </a>
  )
}

function NumberedSteps({ steps }: { steps: { text: React.ReactNode; link?: { href: string; label: string } }[] }) {
  return (
    <ol className="space-y-3 rounded-md border bg-muted/40 p-4">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            {i + 1}
          </span>
          <div className="flex-1 text-sm text-muted-foreground">
            {s.text}
            {s.link && <div><GuideLink href={s.link.href}>{s.link.label}</GuideLink></div>}
          </div>
        </li>
      ))}
    </ol>
  )
}

// --- Step 1: create the Discord app -------------------------------------------

function CreateAppStep({ onNext }: { onNext: () => void }) {
  return (
    <StepShell
      title="First, create a small Discord bot (takes ~2 minutes)"
      footer={
        <>
          <span />
          <Button onClick={onNext}>I have my token</Button>
        </>
      }
    >
      <NumberedSteps
        steps={[
          {
            text: <>Open the <strong>Discord Developer Portal</strong> and click <strong>New Application</strong>. Name it e.g. <code className="rounded bg-background px-1">CoachBoard Helper</code>.</>,
            link: { href: DEV_PORTAL_URL, label: 'Open Developer Portal' },
          },
          {
            text: <>In the left menu, open <strong>Bot</strong>. Turn <strong>OFF</strong> “Public Bot” (it’s your private helper).</>,
          },
          {
            text: <>On the same page, under <strong>Privileged Gateway Intents</strong>, turn <strong>ON</strong> “Message Content Intent”. Without it, Discord hides your athletes’ messages from the bot.</>,
          },
          {
            text: <>Click <strong>Reset Token</strong> → <strong>Copy</strong>. That token is what you’ll paste in the next step. Treat it like a password.</>,
          },
        ]}
      />
      <p className="text-xs text-muted-foreground">
        The bot can only <strong>read messages and reply</strong> in channels you choose — it can’t
        moderate, delete anything, or manage your server.
      </p>
    </StepShell>
  )
}

// --- Step 2: paste the token (auto-validates) -----------------------------------

function TokenStep({
  onBack,
  onValidated,
}: {
  onBack: () => void
  onValidated: (s: PublicDiscordSettings) => void
}) {
  const [token, setToken] = useState('')
  const [state, setState] = useState<'idle' | 'checking' | 'ok' | 'error'>('idle')
  const [error, setError] = useState('')
  const [botName, setBotName] = useState('')
  const [saved, setSaved] = useState<PublicDiscordSettings | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const validate = useCallback(async (value: string) => {
    setState('checking')
    setError('')
    try {
      const res = await fetch('/api/discord/settings/token', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: value }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setState('error')
        setError(data.error ?? 'The token could not be validated')
        return
      }
      const s = data as PublicDiscordSettings
      setSaved(s)
      setBotName(s.botUsername ?? 'your bot')
      setState('ok')
    } catch {
      setState('error')
      setError("You're offline — connect to the internet and try again.")
    }
  }, [])

  // Validate automatically shortly after paste/typing stops.
  const onChange = (value: string) => {
    setToken(value)
    setState('idle')
    if (timer.current) clearTimeout(timer.current)
    if (value.trim().length >= 20) {
      timer.current = setTimeout(() => void validate(value.trim()), 500)
    }
  }

  return (
    <StepShell
      title="Paste your bot token"
      footer={
        <>
          <Button variant="outline" onClick={onBack}>Back</Button>
          <Button disabled={state !== 'ok' || !saved} onClick={() => saved && onValidated(saved)}>
            Continue
          </Button>
        </>
      }
    >
      <div className="space-y-1.5">
        <Label htmlFor="bot-token">Bot token</Label>
        <Input
          id="bot-token"
          type="password"
          value={token}
          placeholder="Paste the token you copied…"
          onChange={(e) => onChange(e.target.value)}
          autoFocus
        />
        <p className="text-xs text-muted-foreground">
          It checks automatically — nothing else to click. The token is encrypted and stays on this computer.
        </p>
      </div>

      {state === 'checking' && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Checking with Discord…
        </p>
      )}
      {state === 'ok' && (
        <p className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4" /> Connected as <strong>{botName}</strong>
        </p>
      )}
      {state === 'error' && (
        <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <span>{error}</span>
        </div>
      )}
    </StepShell>
  )
}

// --- Step 3: invite the bot (auto-advances when it joins) -------------------------

function InviteStep({
  inviteUrl,
  onBack,
  onJoined,
}: {
  inviteUrl: string | null
  onBack: () => void
  onJoined: (guilds: DiscordGuildDto[]) => void
}) {
  const [copied, setCopied] = useState(false)
  const [waiting, setWaiting] = useState(true)

  // Poll until the bot lands in a server, then advance by itself.
  useEffect(() => {
    let cancelled = false
    const check = async () => {
      try {
        const res = await fetch('/api/discord/guilds')
        if (!res.ok) return
        const guilds = (await res.json()) as DiscordGuildDto[]
        if (!cancelled && guilds.length > 0) {
          setWaiting(false)
          onJoined(guilds)
        }
      } catch {
        /* offline blips are fine — keep polling */
      }
    }
    void check()
    const interval = setInterval(() => void check(), 3000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [onJoined])

  const copy = async () => {
    if (!inviteUrl) return
    await navigator.clipboard.writeText(inviteUrl).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <StepShell
      title="Add the bot to your Discord server"
      footer={
        <>
          <Button variant="outline" onClick={onBack}>Back</Button>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {waiting && <Loader2 className="h-3 w-3 animate-spin" />}
            Waiting for the bot to join… this updates by itself.
          </span>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        Click the button, pick your server, and approve. The bot only asks to{' '}
        <strong>view channels, read history and send messages</strong>.
      </p>
      <div className="flex flex-wrap gap-2">
        <a href={inviteUrl ?? '#'} target="_blank" rel="noreferrer">
          <Button disabled={!inviteUrl}>
            Add bot to my server <ExternalLink className="h-4 w-4" />
          </Button>
        </a>
        <Button variant="outline" onClick={copy} disabled={!inviteUrl}>
          <Copy className="h-4 w-4" /> {copied ? 'Copied!' : 'Copy link'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Need a different account? The link works for anyone with “Manage Server” permission — you
        can also paste it to your server admin.
      </p>
    </StepShell>
  )
}

// --- Step 4: pick channels + history window ---------------------------------------

function ChannelStep({
  guilds,
  onBack,
  onDone,
}: {
  guilds: DiscordGuildDto[]
  onBack: () => void
  onDone: () => void
}) {
  const [guildId, setGuildId] = useState<string>(guilds[0]?.id ?? '')
  const [channels, setChannels] = useState<DiscordChannelOptionDto[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [historyDays, setHistoryDays] = useState<30 | 90 | null>(30)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!guildId) return
    let cancelled = false
    setChannels(null)
    fetch(`/api/discord/guilds/${guildId}/channels`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((cs: DiscordChannelOptionDto[]) => {
        if (!cancelled) setChannels(cs)
      })
      .catch(() => {
        if (!cancelled) setError('Could not load channels — check that the bot is still in the server.')
      })
    return () => {
      cancelled = true
    }
  }, [guildId])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const guild = guilds.find((g) => g.id === guildId)
      for (const channelId of selected) {
        const channel = channels?.find((c) => c.id === channelId)
        const res = await fetch('/api/discord/channels', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channelId,
            guildId,
            name: `#${channel?.name ?? channelId}`,
            guildName: guild?.name ?? '',
            historyDays,
          }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          setError(data.error ?? 'Failed to save a channel')
          return
        }
      }
      onDone()
    } finally {
      setSaving(false)
    }
  }

  return (
    <StepShell
      title="Which channels do your athletes post videos in?"
      footer={
        <>
          <Button variant="outline" onClick={onBack}>Back</Button>
          <Button onClick={save} disabled={selected.size === 0 || saving}>
            {saving ? 'Saving…' : `Sync ${selected.size || ''} channel${selected.size === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      {guilds.length > 1 && (
        <div className="space-y-1.5">
          <Label>Server</Label>
          <Select value={guildId} onValueChange={setGuildId}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {guilds.map((g) => (
                <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
        {channels === null ? (
          <p className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading channels…
          </p>
        ) : channels.length === 0 ? (
          <p className="p-2 text-sm text-muted-foreground">
            No text channels visible — give the bot access to at least one channel in Discord.
          </p>
        ) : (
          channels.map((c) => (
            <label
              key={c.id}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/40',
                c.alreadyConfigured && 'cursor-default opacity-50',
              )}
            >
              <input
                type="checkbox"
                checked={c.alreadyConfigured || selected.has(c.id)}
                disabled={c.alreadyConfigured}
                onChange={() => toggle(c.id)}
              />
              #{c.name}
              {c.alreadyConfigured && (
                <span className="text-xs text-muted-foreground">already syncing</span>
              )}
            </label>
          ))
        )}
      </div>

      <div className="space-y-1.5">
        <Label>Import history from</Label>
        <div className="flex gap-2">
          {([
            { value: 30 as const, label: 'Last 30 days — recommended' },
            { value: 90 as const, label: 'Last 90 days' },
            { value: null, label: 'Everything' },
          ]).map((opt) => (
            <button
              key={String(opt.value)}
              type="button"
              onClick={() => setHistoryDays(opt.value)}
              className={cn(
                'rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                historyDays === opt.value
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'hover:bg-accent/40',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          “Everything” can take a while and use a lot of disk space in busy channels.
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <p className="text-xs text-muted-foreground">
        Athletes can also <strong>DM videos straight to the bot</strong> — that starts working
        automatically once you link them to an athlete in the inbox.
      </p>
    </StepShell>
  )
}

// --- Step 5: first sync with live progress + preview --------------------------------

function FirstSyncStep({ onFinish }: { onFinish: () => void }) {
  const [status, setStatus] = useState<SyncStatusDto | null>(null)
  const [preview, setPreview] = useState<DiscordMediaItem[]>([])
  const startedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    const start = async () => {
      if (!startedRef.current) {
        startedRef.current = true
        await fetch('/api/discord/sync', { method: 'POST' }).catch(() => {})
      }
    }
    void start()

    const poll = async () => {
      try {
        const res = await fetch('/api/discord/sync/status')
        if (!res.ok) return
        const s = (await res.json()) as SyncStatusDto
        if (cancelled) return
        setStatus(s)
        if (s.state === 'idle' && s.lastResult) {
          const mediaRes = await fetch('/api/discord/media?filter=all&limit=5')
          if (mediaRes.ok && !cancelled) {
            const data = (await mediaRes.json()) as { items: DiscordMediaItem[] }
            setPreview(data.items)
          }
        }
      } catch {
        /* keep polling */
      }
    }
    void poll()
    const interval = setInterval(() => void poll(), 1500)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const running = !status || status.state === 'running'
  const result = status?.lastResult
  const intentChannels =
    status?.warnings.filter((w) => w.startsWith('intent_missing:')).map((w) => w.split(':')[1]) ?? []
  const intentProblem = intentChannels.length > 0 || (status?.warnings.includes('intent_disabled') ?? false)

  return (
    <StepShell
      title={running ? 'Syncing your channels…' : 'Done — Discord is connected!'}
      footer={
        <>
          <span />
          <Button onClick={onFinish} disabled={running}>
            <PartyPopper className="h-4 w-4" /> Open Discord Inbox
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {status?.channels.map((c) => (
          <div key={c.channelId} className="flex items-center justify-between text-sm">
            <span>{c.name}</span>
            <span className="flex items-center gap-2 text-muted-foreground">
              {c.done ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              ) : c.error ? (
                <AlertTriangle className="h-4 w-4 text-destructive" />
              ) : (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {c.fetched} messages · {c.newMedia} videos
            </span>
          </div>
        ))}
        {status && status.downloads.total > 0 && (
          <p className="text-sm text-muted-foreground">
            Downloading {status.downloads.completed}/{status.downloads.total} files
            {status.downloads.failed > 0 ? ` · ${status.downloads.failed} failed` : ''}
            {status.downloads.skipped > 0 ? ` · ${status.downloads.skipped} skipped (too large)` : ''}
          </p>
        )}
      </div>

      {intentProblem && (
        <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>Message Content Intent is turned off</strong>
            {intentChannels.length > 0 ? ` (detected in ${intentChannels.join(', ')})` : ''} — Discord
            hides message text and attachments from the bot, so nothing can sync. In the Developer
            Portal: your app → <strong>Bot</strong> → <strong>Privileged Gateway Intents</strong> →
            enable <strong>Message Content Intent</strong>, save, then sync again. Nothing is lost —
            the sync waits instead of skipping.
          </span>
        </div>
      )}

      {result && result.code === 'ok' && preview.length > 0 && (
        <div className="rounded-md border bg-muted/30 p-3">
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            Latest synced posts — it works! 🎉
          </p>
          <ul className="space-y-1 text-sm">
            {preview.map((m) => (
              <li key={m.id} className="truncate">
                <span className="font-medium">{m.authorUsername}</span>
                {' · '}
                {m.filename}
                {m.caption ? ` — “${m.caption.slice(0, 60)}”` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result && result.code === 'ok' && result.newMedia === 0 && preview.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No videos found in the selected window — that’s fine. New posts will appear in the inbox
          on the next sync.
        </p>
      )}
      {result && result.code === 'offline' && (
        <p className="text-sm text-muted-foreground">
          You seem to be offline — the sync will run automatically next time you open CoachBoard.
        </p>
      )}
      {result && (result.code === 'error' || result.code === 'unauthorized') && (
        <p className="text-sm text-destructive">
          {result.code === 'unauthorized'
            ? 'Discord rejected the token — go to Settings and reconnect.'
            : result.message ?? 'Something went wrong during the sync.'}
        </p>
      )}
    </StepShell>
  )
}
