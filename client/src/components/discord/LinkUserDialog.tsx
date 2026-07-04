import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../ui/select'
import { useToast } from '../ui/toast'
import type { Athlete } from 'coachboard-shared'
import type { DiscordUserItem } from 'coachboard-shared/discord'

/**
 * Link a Discord user to an athlete. Linking retro-files ALL of the user's
 * posts (past and future) and opens the bot↔athlete DM channel for syncing.
 */
export default function LinkUserDialog({
  user,
  onClose,
  onLinked,
}: {
  user: DiscordUserItem | null
  onClose: () => void
  onLinked: () => void
}) {
  const toast = useToast()
  const [athletes, setAthletes] = useState<Athlete[]>([])
  const [athleteId, setAthleteId] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!user) return
    setAthleteId(user.athleteId ?? '')
    let cancelled = false
    fetch('/api/athletes')
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Athlete[]) => {
        if (!cancelled) setAthletes(rows.filter((a) => !a.archived))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [user])

  const link = async () => {
    if (!user || !athleteId) return
    setBusy(true)
    try {
      const res = await fetch(`/api/discord/users/${user.id}/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ athleteId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to link')
        return
      }
      const athlete = athletes.find((a) => a.id === athleteId)
      toast.success(
        `${user.username} linked to ${athlete?.name ?? 'athlete'} — ${data.updatedMedia} post${data.updatedMedia === 1 ? '' : 's'} filed`,
      )
      onClose()
      onLinked()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!user} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        {user && (
          <>
            <DialogHeader>
              <DialogTitle>Who is {user.displayName ?? user.username}?</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Pick the athlete behind the Discord account{' '}
                <strong>@{user.username}</strong>. This files{' '}
                <strong>all {user.mediaCount} of their posts</strong> — past and future — under
                that athlete, and lets them DM videos straight to the bot.
              </p>
              <Select value={athleteId} onValueChange={setAthleteId}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose athlete…" />
                </SelectTrigger>
                <SelectContent>
                  {athletes.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={onClose}>Cancel</Button>
                <Button onClick={link} disabled={!athleteId || busy}>
                  {busy ? 'Linking…' : 'Link athlete'}
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
