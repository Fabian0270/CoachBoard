import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { Textarea } from '../ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { useToast } from '../ui/toast'
import { Send, CalendarCheck2 } from 'lucide-react'
import MediaTile from './MediaTile'
import MediaPlayerDialog from './MediaPlayerDialog'
import type { DiscordMediaItem, DiscordUserItem } from 'coachboard-shared/discord'

/**
 * Athlete detail → Videos tab. Month-grouped grid of everything the athlete
 * has posted (channel or DM), plus a quick "Message on Discord" DM composer
 * when the athlete has a linked account.
 */
export default function AthleteMediaSection({ athleteId }: { athleteId: string }) {
  const [items, setItems] = useState<DiscordMediaItem[] | null>(null)
  const [hasLink, setHasLink] = useState(false)
  const [playing, setPlaying] = useState<DiscordMediaItem | null>(null)
  const [dmOpen, setDmOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const [mediaRes, usersRes] = await Promise.all([
        fetch(`/api/discord/media?filter=all&athleteId=${athleteId}&limit=200`),
        fetch('/api/discord/users'),
      ])
      if (mediaRes.ok) {
        const data = await mediaRes.json()
        setItems(data.items ?? [])
      } else {
        setItems([])
      }
      if (usersRes.ok) {
        const users = (await usersRes.json()) as DiscordUserItem[]
        setHasLink(users.some((u) => u.athleteId === athleteId))
      }
    } catch {
      setItems([])
    }
  }, [athleteId])

  useEffect(() => {
    void load()
  }, [load])

  if (items === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }

  // Group by month (posted_at is ISO — slice gives YYYY-MM).
  const byMonth = new Map<string, DiscordMediaItem[]>()
  for (const m of items) {
    const key = m.postedAt.slice(0, 7)
    const list = byMonth.get(key) ?? []
    list.push(m)
    byMonth.set(key, list)
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>Videos from Discord{items.length > 0 ? ` (${items.length})` : ''}</CardTitle>
        {hasLink && (
          <Button size="sm" variant="outline" onClick={() => setDmOpen(true)}>
            <Send className="h-4 w-4" /> Message on Discord
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        {items.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No synced videos for this athlete yet. Once their Discord account is linked, everything
            they post (or DM to the bot) shows up here.
          </p>
        ) : (
          [...byMonth.entries()].map(([month, monthItems]) => (
            <div key={month} className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {month}
              </p>
              <div className="flex flex-wrap gap-3">
                {monthItems.map((m) => (
                  <div key={m.id} className="w-32 space-y-1">
                    <MediaTile item={m} onOpen={setPlaying} />
                    <p className="truncate text-[10px] text-muted-foreground">
                      {m.postedAt.slice(0, 10)}
                    </p>
                    {m.workoutId && (
                      <Badge className="max-w-full truncate bg-emerald-100 text-[10px] text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300">
                        <CalendarCheck2 className="mr-0.5 h-3 w-3 shrink-0" />
                        {m.workoutName}
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </CardContent>

      <MediaPlayerDialog item={playing} onClose={() => setPlaying(null)} />
      <DmComposerDialog athleteId={athleteId} open={dmOpen} onOpenChange={setDmOpen} />
    </Card>
  )
}

function DmComposerDialog({
  athleteId,
  open,
  onOpenChange,
}: {
  athleteId: string
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const toast = useToast()
  const [content, setContent] = useState('')
  const [sending, setSending] = useState(false)

  const send = async () => {
    if (!content.trim()) return
    setSending(true)
    try {
      const res = await fetch(`/api/discord/athletes/${athleteId}/dm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to send')
        return
      }
      if (data.status === 'sent') {
        toast.success('DM sent on Discord')
        setContent('')
        onOpenChange(false)
      } else {
        toast.error(data.error ?? 'Discord rejected the message')
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Message on Discord</DialogTitle>
        </DialogHeader>
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="e.g. Great session today — bump top set to 182.5 next week."
          rows={3}
          autoFocus
        />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={send} disabled={sending || !content.trim()}>
            <Send className="h-4 w-4" /> {sending ? 'Sending…' : 'Send DM'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
