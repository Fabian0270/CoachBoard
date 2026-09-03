import { useEffect, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import { useToast } from '../ui/toast'
import { useConfirm } from '../ui/confirm-dialog'
import { LineChart, MessageSquareReply, Send, Trash2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { DiscordMediaItem, SentMessageDto } from 'coachboard-shared/discord'

/**
 * The only place a <video> element is ever mounted (one at a time). The file
 * route serves HTTP Range, so seeking works. Below the media: the original
 * caption and a quick-reply box — back into the source channel as a real
 * Discord reply, or as a DM to the athlete.
 */
export default function MediaPlayerDialog({
  item,
  onClose,
  onDeleted,
}: {
  item: DiscordMediaItem | null
  onClose: () => void
  /** Provide to show a Delete button; called after a successful delete. */
  onDeleted?: () => void
}) {
  const toast = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<SentMessageDto[]>([])

  const del = async () => {
    if (!item) return
    const ok = await confirm({
      title: 'Delete this video?',
      description: 'This permanently removes the file and its record from CoachBoard to free up space. This cannot be undone.',
      destructive: true,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    const res = await fetch(`/api/discord/media/${item.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success('Video deleted')
      onClose()
      onDeleted?.()
    } else {
      toast.error('Failed to delete the video')
    }
  }

  useEffect(() => {
    setReply('')
    setSent([])
    if (!item) return
    let cancelled = false
    fetch(`/api/discord/media/${item.id}/sent`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: SentMessageDto[]) => {
        if (!cancelled) setSent(rows)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [item])

  const sendReply = async (via: 'channel' | 'dm') => {
    if (!item || !reply.trim()) {
      toast.error('Write a message first')
      return
    }
    setSending(true)
    try {
      const res = await fetch(`/api/discord/media/${item.id}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: reply.trim(), via }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to send')
        return // keep the text so the coach can retry
      }
      const dto = data as SentMessageDto
      setSent((list) => [...list, dto])
      if (dto.status === 'sent') {
        toast.success(via === 'dm' ? 'DM sent' : `Reply posted in ${item.channelName ?? 'the channel'}`)
        setReply('')
      } else {
        toast.error(dto.error ?? 'Discord rejected the message')
      }
    } finally {
      setSending(false)
    }
  }

  const fileUrl = item ? `/api/discord/media/${item.id}/file` : ''

  return (
    <Dialog open={!!item} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        {item && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                {item.athleteName ?? item.authorDisplayName ?? item.authorUsername}
                <span className="text-sm font-normal text-muted-foreground">
                  · {item.postedAt.slice(0, 10)}
                  {item.channelName ? ` · ${item.channelName}` : ''}
                </span>
              </DialogTitle>
            </DialogHeader>

            <div className="flex max-h-[55vh] items-center justify-center overflow-hidden rounded-md bg-black/90">
              {item.isVideo ? (
                <video
                  key={item.id}
                  src={fileUrl}
                  controls
                  preload="metadata"
                  className="max-h-[55vh] w-full"
                />
              ) : (
                <img src={fileUrl} alt={item.filename} className="max-h-[55vh] object-contain" />
              )}
            </div>

            {item.caption && (
              <p className="text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{item.authorUsername}:</span>{' '}
                {item.caption}
              </p>
            )}

            {sent.length > 0 && (
              <div className="space-y-1 rounded-md border bg-muted/30 p-3">
                <p className="text-xs font-medium text-muted-foreground">Your replies</p>
                {sent.map((s) => (
                  <p key={s.id} className="text-sm">
                    <span className="text-xs text-muted-foreground">
                      {s.createdAt.slice(0, 10)} · {s.kind === 'dm' ? 'DM' : 'channel'}
                      {s.status === 'failed' ? ' · not delivered' : ''}
                    </span>{' '}
                    {s.content}
                    {s.status === 'failed' && s.error && (
                      <span className="block text-xs text-destructive">{s.error}</span>
                    )}
                  </p>
                ))}
              </div>
            )}

            <div className="space-y-2">
              <Textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Quick feedback to the athlete…"
                rows={2}
              />
              <div className="flex flex-wrap gap-2">
                {item.isVideo && item.thumbStatus !== 'unsupported' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      onClose()
                      navigate(`/analysis/${item.id}`)
                    }}
                  >
                    <LineChart className="h-4 w-4" />
                    Analyse bar path
                  </Button>
                )}
                <Button size="sm" onClick={() => sendReply('channel')} disabled={sending || !reply.trim()}>
                  <MessageSquareReply className="h-4 w-4" />
                  {sending ? 'Sending…' : `Reply in ${item.channelName ?? 'channel'}`}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => sendReply('dm')}
                  disabled={sending || !reply.trim()}
                >
                  <Send className="h-4 w-4" />
                  Send as DM
                </Button>
                {onDeleted && (
                  <Button size="sm" variant="ghost" className="ml-auto text-destructive" onClick={del}>
                    <Trash2 className="h-4 w-4" /> Delete
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
