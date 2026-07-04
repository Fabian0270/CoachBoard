import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardContent } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/tabs'
import { useToast } from '../components/ui/toast'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '../components/ui/dialog'
import { MessageSquare, Check, RefreshCw, CalendarCheck2 } from 'lucide-react'
import MediaThumb from '../components/discord/MediaThumb'
import MediaPlayerDialog from '../components/discord/MediaPlayerDialog'
import LinkUserDialog from '../components/discord/LinkUserDialog'
import type {
  DiscordMediaItem, DiscordUserItem, WorkoutCandidate, PublicDiscordSettings, UnreadThread,
} from 'coachboard-shared/discord'

/**
 * Triage for synced Discord posts. Unmatched: link the Discord account to an
 * athlete once and everything files itself. Needs review: confirm the
 * suggested workout day (or pick another) and mark reviewed.
 */
export default function DiscordInbox() {
  const toast = useToast()
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [unmatched, setUnmatched] = useState<DiscordMediaItem[]>([])
  const [unreviewed, setUnreviewed] = useState<DiscordMediaItem[]>([])
  const [unread, setUnread] = useState<UnreadThread[]>([])
  const [users, setUsers] = useState<DiscordUserItem[]>([])
  const [playing, setPlaying] = useState<DiscordMediaItem | null>(null)
  const [linking, setLinking] = useState<DiscordUserItem | null>(null)
  const [picking, setPicking] = useState<DiscordMediaItem | null>(null)

  const load = useCallback(async () => {
    try {
      const [s, um, ur, us, un] = await Promise.all([
        fetch('/api/discord/settings').then((r) => r.json() as Promise<PublicDiscordSettings>),
        fetch('/api/discord/media?filter=unmatched').then((r) => r.json()),
        fetch('/api/discord/media?filter=unreviewed').then((r) => r.json()),
        fetch('/api/discord/users').then((r) => r.json() as Promise<DiscordUserItem[]>),
        fetch('/api/discord/messages/unread').then((r) => r.json() as Promise<UnreadThread[]>),
      ])
      setConfigured(s.configured)
      setUnmatched(um.items ?? [])
      setUnreviewed(ur.items ?? [])
      setUsers(us)
      setUnread(Array.isArray(un) ? un : [])
    } catch {
      setConfigured(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const confirmWorkout = async (item: DiscordMediaItem, workoutId: string) => {
    const res = await fetch(`/api/discord/media/${item.id}/workout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workoutId }),
    })
    if (res.ok) {
      toast.success('Attached to the training day')
      void load()
    }
  }

  const markReviewed = async (item: DiscordMediaItem) => {
    await fetch(`/api/discord/media/${item.id}/reviewed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewed: true }),
    })
    void load()
  }

  const retry = async (item: DiscordMediaItem) => {
    toast.info('Retrying download…')
    const res = await fetch(`/api/discord/media/${item.id}/retry-download`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error ?? 'Retry failed')
    }
    void load()
  }

  if (configured === false) {
    return (
      <div className="space-y-4">
        <Header unmatchedCount={0} unreviewedCount={0} />
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Discord isn’t connected yet.{' '}
            <Link to="/settings" className="text-primary underline">
              Connect it in Settings
            </Link>{' '}
            to pull your athletes’ form-check videos in here.
          </CardContent>
        </Card>
      </div>
    )
  }

  // Unmatched grouped by Discord user (link once → files everything).
  const byUser = new Map<string, DiscordMediaItem[]>()
  for (const m of unmatched) {
    const list = byUser.get(m.discordUserId) ?? []
    list.push(m)
    byUser.set(m.discordUserId, list)
  }

  return (
    <div className="space-y-4">
      <Header unmatchedCount={unmatched.length} unreviewedCount={unreviewed.length} />

      <Tabs defaultValue={unmatched.length > 0 ? 'unmatched' : 'review'}>
        <TabsList>
          <TabsTrigger value="unmatched">
            Unmatched{unmatched.length > 0 ? ` (${unmatched.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="review">
            Needs review{unreviewed.length > 0 ? ` (${unreviewed.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="messages">
            Messages{unread.length > 0 ? ` (${unread.length})` : ''}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="unmatched" className="space-y-4">
          {byUser.size === 0 ? (
            <EmptyState text="Nothing to match — every synced post belongs to a linked athlete. 💪" />
          ) : (
            [...byUser.entries()].map(([userId, items]) => {
              const user = users.find((u) => u.id === userId)
              return (
                <Card key={userId}>
                  <CardContent className="space-y-3 pt-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {user?.avatarUrl && (
                          <img src={user.avatarUrl} alt="" className="h-7 w-7 rounded-full" />
                        )}
                        <span className="font-medium">
                          {user?.displayName ?? items[0].authorDisplayName ?? items[0].authorUsername}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          @{items[0].authorUsername} · {items.length} post{items.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      {user && (
                        <Button size="sm" onClick={() => setLinking(user)}>
                          Link to athlete
                        </Button>
                      )}
                    </div>
                    <MediaRowList
                      items={items}
                      onOpen={setPlaying}
                      onRetry={retry}
                      onDeleted={load}
                    />
                  </CardContent>
                </Card>
              )
            })
          )}
        </TabsContent>

        <TabsContent value="review" className="space-y-3">
          {unreviewed.length === 0 ? (
            <EmptyState text="All caught up — no new posts to review." />
          ) : (
            unreviewed.map((item) => (
              <Card key={item.id}>
                <CardContent className="flex flex-wrap items-center gap-4 pt-4">
                  <MediaThumb item={item} onOpen={setPlaying} onDeleted={load} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-sm font-medium">
                      {item.athleteName}
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {item.postedAt.slice(0, 10)}
                        {item.channelName ? ` · ${item.channelName}` : ''}
                      </span>
                    </p>
                    {item.caption && (
                      <p className="truncate text-sm text-muted-foreground">“{item.caption}”</p>
                    )}
                    <CaptionChips item={item} />
                    <StatusChips item={item} onRetry={retry} />
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    {item.workoutId ? (
                      <Badge className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                        <CalendarCheck2 className="mr-1 h-3 w-3" />
                        {item.workoutName} · {item.workoutDate}
                      </Badge>
                    ) : item.suggestedWorkoutId ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">
                          Suggested: {item.suggestedWorkoutName} · {item.suggestedWorkoutDate}
                        </span>
                        <Button
                          size="sm"
                          onClick={() => confirmWorkout(item, item.suggestedWorkoutId!)}
                        >
                          <Check className="h-4 w-4" /> Confirm
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setPicking(item)}>
                          Pick other…
                        </Button>
                      </div>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => setPicking(item)}>
                        Attach to a day…
                      </Button>
                    )}
                    {!item.workoutId && (
                      <button
                        type="button"
                        onClick={() => markReviewed(item)}
                        className="text-xs text-muted-foreground underline"
                      >
                        Mark reviewed without attaching
                      </button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>

        <TabsContent value="messages" className="space-y-2">
          {unread.length === 0 ? (
            <EmptyState text="No unread messages. Athlete DMs show up here." />
          ) : (
            unread.map((t) => (
              <Link key={t.athleteId} to={`/athletes/${t.athleteId}?tab=messages`} className="block">
                <Card className="transition-shadow hover:shadow-md">
                  <CardContent className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="font-medium">{t.athleteName}</p>
                      <p className="truncate text-sm text-muted-foreground">{t.lastMessage}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {t.lastAt.slice(0, 16).replace('T', ' ')}
                      </span>
                      <Badge className="bg-red-500 text-white hover:bg-red-500">{t.unread}</Badge>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))
          )}
        </TabsContent>
      </Tabs>

      <MediaPlayerDialog item={playing} onClose={() => setPlaying(null)} onDeleted={load} />
      <LinkUserDialog user={linking} onClose={() => setLinking(null)} onLinked={load} />
      <WorkoutPickerDialog
        item={picking}
        onClose={() => setPicking(null)}
        onPicked={(workoutId) => {
          if (picking) void confirmWorkout(picking, workoutId)
          setPicking(null)
        }}
      />
    </div>
  )
}

function Header({ unmatchedCount, unreviewedCount }: { unmatchedCount: number; unreviewedCount: number }) {
  const total = unmatchedCount + unreviewedCount
  return (
    <div className="flex items-center gap-3">
      <MessageSquare className="h-6 w-6 text-muted-foreground" />
      <h1 className="text-3xl font-bold">Inbox</h1>
      {total > 0 && <Badge>{total} new</Badge>}
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <Card>
      <CardContent className="py-8 text-center text-muted-foreground">{text}</CardContent>
    </Card>
  )
}

function MediaRowList({
  items,
  onOpen,
  onRetry,
  onDeleted,
}: {
  items: DiscordMediaItem[]
  onOpen: (m: DiscordMediaItem) => void
  onRetry: (m: DiscordMediaItem) => void
  onDeleted: () => void
}) {
  return (
    <div className="flex flex-wrap gap-3">
      {items.map((m) => (
        <div key={m.id} className="w-32 space-y-1">
          <MediaThumb item={m} onOpen={onOpen} onDeleted={onDeleted} />
          <p className="truncate text-[10px] text-muted-foreground">{m.postedAt.slice(0, 10)}</p>
          {m.caption && <p className="truncate text-[10px] text-muted-foreground">“{m.caption}”</p>}
          <StatusChips item={m} onRetry={onRetry} compact />
        </div>
      ))}
    </div>
  )
}

/** Parsed-caption chips like "180 kg × 2 @8" — the athlete's own numbers at a glance. */
function CaptionChips({ item }: { item: DiscordMediaItem }) {
  const p = item.parsedCaption
  if (!p || (p.weightKg == null && p.reps == null && p.rpe == null)) return null
  const parts: string[] = []
  if (p.weightKg != null) parts.push(`${p.weightKg} kg`)
  if (p.reps != null) parts.push(`× ${p.reps}`)
  if (p.rpe != null) parts.push(`@${p.rpe}`)
  return (
    <Badge className="bg-primary/10 text-primary hover:bg-primary/10">{parts.join(' ')}</Badge>
  )
}

function StatusChips({
  item,
  onRetry,
  compact,
}: {
  item: DiscordMediaItem
  onRetry: (m: DiscordMediaItem) => void
  compact?: boolean
}) {
  if (item.downloadStatus === 'downloaded') {
    return item.duplicateOfId ? (
      <Badge className="bg-muted text-muted-foreground hover:bg-muted">Duplicate</Badge>
    ) : null
  }
  if (item.downloadStatus === 'pending') {
    return <Badge className="bg-muted text-muted-foreground hover:bg-muted">Downloading…</Badge>
  }
  if (item.downloadStatus === 'skipped_too_large') {
    return (
      <span className="flex items-center gap-1">
        <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 hover:bg-amber-100">
          Too large
        </Badge>
        {!compact && (
          <button type="button" onClick={() => onRetry(item)} className="text-xs underline">
            download anyway
          </button>
        )}
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1">
      <Badge className="bg-destructive/10 text-destructive hover:bg-destructive/10">
        Download failed
      </Badge>
      <button
        type="button"
        onClick={() => onRetry(item)}
        className="inline-flex items-center gap-0.5 text-xs underline"
      >
        <RefreshCw className="h-3 w-3" /> retry
      </button>
    </span>
  )
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "same day" / "+2 d" chip relative to when the video was posted (UTC dates). */
function relativeDayLabel(scheduledDate: string, postedDate: string): string {
  const diff = Math.round((Date.parse(scheduledDate) - Date.parse(postedDate)) / 86_400_000)
  if (diff === 0) return 'same day'
  return diff > 0 ? `+${diff} d` : `${diff} d`
}

/** "Pick other…" — nearby training days (±7 d), grouped by program. */
function WorkoutPickerDialog({
  item,
  onClose,
  onPicked,
}: {
  item: DiscordMediaItem | null
  onClose: () => void
  onPicked: (workoutId: string) => void
}) {
  const [candidates, setCandidates] = useState<WorkoutCandidate[] | null>(null)

  useEffect(() => {
    if (!item) return
    setCandidates(null)
    let cancelled = false
    fetch(`/api/discord/media/${item.id}/workout-candidates`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: WorkoutCandidate[]) => {
        if (!cancelled) setCandidates(rows)
      })
      .catch(() => {
        if (!cancelled) setCandidates([])
      })
    return () => {
      cancelled = true
    }
  }, [item])

  const postedDate = item?.postedAt.slice(0, 10) ?? ''

  // Group by program, preserving the server's order (active program first,
  // then closest day first inside it).
  const groups = new Map<string, { name: string; items: WorkoutCandidate[] }>()
  for (const c of candidates ?? []) {
    const g = groups.get(c.programId) ?? { name: c.programName, items: [] }
    g.items.push(c)
    groups.set(c.programId, g)
  }

  return (
    <Dialog open={!!item} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Attach to which training day?</DialogTitle>
        </DialogHeader>
        {item && (
          <p className="text-xs text-muted-foreground">
            Video posted {WEEKDAYS[new Date(postedDate).getUTCDay()]} {postedDate} — showing
            training days within a week.
          </p>
        )}
        {candidates === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No training days scheduled within a week of this post. Create the day in the program
            first, then attach the video from here.
          </p>
        ) : (
          <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
            {[...groups.entries()].map(([programId, group]) => (
              <div key={programId}>
                <p className="sticky top-0 bg-background py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.name}
                </p>
                <div className="space-y-0.5">
                  {group.items
                    .slice()
                    .sort((a, b) => (a.scheduledDate! < b.scheduledDate! ? -1 : 1))
                    .map((c) => {
                      const sameDay = c.scheduledDate === postedDate
                      return (
                        <button
                          key={c.workoutId}
                          type="button"
                          onClick={() => onPicked(c.workoutId)}
                          className={cnPicker(sameDay)}
                        >
                          <span className="min-w-0 truncate">
                            <span className="text-muted-foreground">
                              {WEEKDAYS[new Date(c.scheduledDate!).getUTCDay()]} {c.scheduledDate}
                            </span>
                            <span className="ml-2 font-medium">{c.workoutName}</span>
                          </span>
                          <span
                            className={
                              sameDay
                                ? 'shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary'
                                : 'shrink-0 text-[10px] text-muted-foreground'
                            }
                          >
                            {relativeDayLabel(c.scheduledDate!, postedDate)}
                          </span>
                        </button>
                      )
                    })}
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function cnPicker(sameDay: boolean): string {
  return [
    'flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent/40',
    sameDay ? 'bg-primary/5 ring-1 ring-inset ring-primary/30' : '',
  ].join(' ')
}
