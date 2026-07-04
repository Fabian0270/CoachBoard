import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { useToast } from '../ui/toast'
import { useConfirm } from '../ui/confirm-dialog'
import {
  MessageSquare, RefreshCw, AlertTriangle, Unplug, Loader2, Trash2,
} from 'lucide-react'
import DiscordSetupWizard from './DiscordSetupWizard'
import DisconnectDiscordDialog from './DisconnectDiscordDialog'
import type {
  PublicDiscordSettings, ConfiguredChannelDto, SyncStatusDto,
} from 'coachboard-shared/discord'

/**
 * Settings → Discord. Unconfigured: a one-liner + Connect button (wizard).
 * Configured: bot identity, synced channels with per-channel error notices,
 * Sync now with live status, auto-sync interval, Reconnect banner, Disconnect.
 */
export default function DiscordSettingsCard() {
  const toast = useToast()
  const confirm = useConfirm()
  const [settings, setSettings] = useState<PublicDiscordSettings | null>(null)
  const [channels, setChannels] = useState<ConfiguredChannelDto[]>([])
  const [status, setStatus] = useState<SyncStatusDto | null>(null)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [disconnectOpen, setDisconnectOpen] = useState(false)
  const [clearDays, setClearDays] = useState(30)
  const [clearing, setClearing] = useState(false)
  const wasRunning = useRef(false)

  const load = useCallback(async () => {
    try {
      const [sRes, cRes] = await Promise.all([
        fetch('/api/discord/settings'),
        fetch('/api/discord/channels'),
      ])
      if (sRes.ok) setSettings(await sRes.json())
      if (cRes.ok) setChannels(await cRes.json())
    } catch {
      /* offline — leave as-is */
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Poll sync status while a sync is running; toast on the running→idle edge.
  useEffect(() => {
    if (!settings?.configured) return
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch('/api/discord/sync/status')
        if (!res.ok || cancelled) return
        const s = (await res.json()) as SyncStatusDto
        setStatus(s)
        if (wasRunning.current && s.state === 'idle' && s.lastResult) {
          wasRunning.current = false
          void load()
          const r = s.lastResult
          if (r.code === 'ok') {
            toast.success(`Discord sync complete — ${r.newMedia} new file${r.newMedia === 1 ? '' : 's'}`)
          } else if (r.code === 'unauthorized') {
            toast.error('Discord rejected the bot token — reconnect below.')
          } else if (r.code === 'error') {
            toast.error(r.message ?? 'Discord sync failed')
          }
        }
        if (s.state === 'running') wasRunning.current = true
      } catch {
        /* offline */
      }
    }
    void poll()
    const interval = setInterval(() => void poll(), 1500)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [settings?.configured, load, toast])

  const syncNow = async () => {
    const res = await fetch('/api/discord/sync', { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (data.started) {
      wasRunning.current = true
      toast.info('Sync started…')
    } else if (data.reason === 'token_invalid') {
      toast.error('The bot token is no longer valid — reconnect first.')
    } else if (data.reason === 'already_running') {
      toast.info('A sync is already running')
    }
  }

  const toggleChannel = async (channel: ConfiguredChannelDto, enabled: boolean) => {
    const res = await fetch(`/api/discord/channels/${channel.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    if (res.ok) {
      const updated = (await res.json()) as ConfiguredChannelDto
      setChannels((list) => list.map((c) => (c.id === updated.id ? updated : c)))
    }
  }

  const removeChannel = async (channel: ConfiguredChannelDto) => {
    await fetch(`/api/discord/channels/${channel.id}`, { method: 'DELETE' })
    setChannels((list) => list.filter((c) => c.id !== channel.id))
  }

  const saveAutoSync = async (enabled: boolean, minutes: number) => {
    const res = await fetch('/api/discord/settings/auto-sync', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, minutes }),
    })
    if (res.ok) setSettings(await res.json())
  }

  const saveRetention = async (days: number) => {
    const res = await fetch('/api/discord/settings/retention', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    })
    if (res.ok) setSettings(await res.json())
  }

  const saveMessageRetention = async (days: number) => {
    const res = await fetch('/api/discord/settings/message-retention', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    })
    if (res.ok) setSettings(await res.json())
  }

  const clearCache = async () => {
    const ok = await confirm({
      title: `Delete media older than ${clearDays} days?`,
      description: `This permanently removes all synced videos AND messages older than ${clearDays} days to free up space. This cannot be undone.`,
      destructive: true,
      confirmLabel: 'Delete now',
    })
    if (!ok) return
    setClearing(true)
    try {
      const res = await fetch('/api/discord/clear-cache', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: clearDays }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to clear cache')
        return
      }
      toast.success(`Freed up space — deleted ${data.videosDeleted} video${data.videosDeleted === 1 ? '' : 's'} and ${data.messagesDeleted} message${data.messagesDeleted === 1 ? '' : 's'}`)
      void load()
    } finally {
      setClearing(false)
    }
  }

  const guildChannels = channels.filter((c) => c.kind === 'guild')
  const dmChannels = channels.filter((c) => c.kind === 'dm')
  const running = status?.state === 'running'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5" /> Discord
        </CardTitle>
        <CardDescription>
          Pull your athletes’ form-check videos straight from your Discord server into CoachBoard,
          and send quick feedback back — without leaving the app. Everything stays on this computer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!settings?.configured ? (
          <Button onClick={() => setWizardOpen(true)}>Connect Discord</Button>
        ) : (
          <>
            {settings.tokenInvalid && (
              <div className="flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                <span className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
                  Discord no longer accepts the bot token (it may have been reset). Reconnect to
                  continue syncing.
                </span>
                <Button size="sm" onClick={() => setWizardOpen(true)}>Reconnect</Button>
              </div>
            )}

            <p className="text-sm text-emerald-600 dark:text-emerald-400">
              ✓ Connected as <strong>{settings.botUsername}</strong>
            </p>

            {(status?.warnings.includes('intent_disabled') ||
              status?.warnings.some((w) => w.startsWith('intent_missing:'))) && (
              <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <strong>Message Content Intent is off</strong>, so Discord hides messages from the
                  bot and channel sync is paused. Developer Portal → your app →{' '}
                  <strong>Bot</strong> → enable <strong>Message Content Intent</strong>, save, then
                  sync again.
                </span>
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Synced channels</Label>
              {guildChannels.length === 0 && (
                <p className="text-sm text-muted-foreground">No channels selected yet.</p>
              )}
              {guildChannels.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-accent/30"
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={c.enabled && !c.syncError}
                      onChange={(e) => toggleChannel(c, e.target.checked)}
                    />
                    {c.name}
                    <span className="text-xs text-muted-foreground">{c.guildName}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    {c.syncError && (
                      <span className="text-xs text-amber-600 dark:text-amber-400">
                        {c.syncError === 'forbidden'
                          ? 'Bot lost access — check channel permissions, then re-enable'
                          : 'Channel no longer exists'}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeChannel(c)}
                      className="text-xs text-muted-foreground underline"
                    >
                      Remove
                    </button>
                  </span>
                </div>
              ))}
              {dmChannels.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  + {dmChannels.length} athlete DM{dmChannels.length === 1 ? '' : 's'} syncing
                  automatically (created when you link an athlete).
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={syncNow} disabled={running || settings.tokenInvalid}>
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {running ? 'Syncing…' : 'Sync now'}
              </Button>
              {status?.lastResult && !running && (
                <span className="text-xs text-muted-foreground">
                  Last sync: {status.lastResult.finishedAt.slice(0, 16).replace('T', ' ')} ·{' '}
                  {status.lastResult.code === 'ok'
                    ? `${status.lastResult.newMedia} new`
                    : status.lastResult.code}
                </span>
              )}
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={settings.autoSyncEnabled}
                  onChange={(e) => saveAutoSync(e.target.checked, settings.autoSyncMinutes)}
                />
                Auto-sync while CoachBoard is open
              </label>
              {settings.autoSyncEnabled && (
                <span className="flex items-center gap-1 text-sm text-muted-foreground">
                  every
                  <Input
                    type="number"
                    min={5}
                    className="h-7 w-16"
                    value={settings.autoSyncMinutes}
                    onChange={(e) =>
                      saveAutoSync(true, Math.max(5, Number(e.target.value) || 30))
                    }
                  />
                  min
                </span>
              )}
            </div>

            <div className="space-y-3 rounded-md border p-3">
              <p className="text-sm font-medium">Storage &amp; cleanup</p>

              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-40">Auto-delete videos</span>
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                  value={settings.retentionDays}
                  onChange={(e) => saveRetention(Number(e.target.value))}
                >
                  <option value={0}>Never</option>
                  <option value={30}>after 30 days</option>
                  <option value={60}>after 60 days</option>
                  <option value={90}>after 90 days</option>
                  <option value={180}>after 180 days</option>
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="w-40">Auto-delete messages</span>
                <select
                  className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                  value={settings.messageRetentionDays}
                  onChange={(e) => saveMessageRetention(Number(e.target.value))}
                >
                  <option value={0}>Never</option>
                  <option value={30}>after 30 days</option>
                  <option value={60}>after 60 days</option>
                  <option value={90}>after 90 days</option>
                  <option value={180}>after 180 days</option>
                </select>
              </div>
              <p className="text-xs text-muted-foreground">
                Old form-check videos and DM messages are removed automatically to free up space
                (video deletion includes ones attached to program days).
              </p>

              <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm">
                <span>Clear now — delete videos &amp; messages older than</span>
                <Input
                  type="number"
                  min={0}
                  className="h-8 w-16"
                  value={clearDays}
                  onChange={(e) => setClearDays(Math.max(0, Number(e.target.value) || 0))}
                />
                <span>days</span>
                <Button variant="outline" size="sm" onClick={clearCache} disabled={clearing}>
                  <Trash2 className="h-4 w-4" /> {clearing ? 'Clearing…' : 'Free up space'}
                </Button>
              </div>
            </div>

            <div className="pt-1">
              <Button variant="outline" onClick={() => setDisconnectOpen(true)}>
                <Unplug className="h-4 w-4" /> Disconnect
              </Button>
            </div>
          </>
        )}
      </CardContent>

      <DiscordSetupWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        onConnected={(s) => setSettings(s)}
      />
      <DisconnectDiscordDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        onDisconnected={() => {
          setSettings((s) => (s ? { ...s, configured: false, tokenInvalid: false } : s))
          setChannels([])
          void load()
        }}
      />
    </Card>
  )
}
