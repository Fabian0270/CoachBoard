import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent } from '../ui/card'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import { useToast } from '../ui/toast'
import { Send } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ConversationMessage } from 'coachboard-shared/discord'

/**
 * Athlete detail → Messages tab. The private DM conversation (athlete ↔ bot):
 * inbound messages the athlete DMs to the bot (picked up by sync) and outbound
 * DMs the coach sends from here. Marks the thread read on open.
 */
export default function AthleteMessagesSection({ athleteId }: { athleteId: string }) {
  const toast = useToast()
  const [messages, setMessages] = useState<ConversationMessage[] | null>(null)
  const [linked, setLinked] = useState(true)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const [convRes, usersRes] = await Promise.all([
        fetch(`/api/discord/athletes/${athleteId}/messages`),
        fetch('/api/discord/users'),
      ])
      if (convRes.ok) setMessages(await convRes.json())
      else setMessages([])
      if (usersRes.ok) {
        const users = await usersRes.json()
        setLinked(users.some((u: { athleteId: string | null }) => u.athleteId === athleteId))
      }
    } catch {
      setMessages([])
    }
  }, [athleteId])

  useEffect(() => {
    void load()
    // Opening the thread clears the unread badge.
    void fetch(`/api/discord/athletes/${athleteId}/messages/read`, { method: 'POST' }).catch(() => {})
  }, [athleteId, load])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  const send = async () => {
    if (!draft.trim()) return
    setSending(true)
    try {
      const res = await fetch(`/api/discord/athletes/${athleteId}/dm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: draft.trim() }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to send')
        return // keep the draft so the coach can retry
      }
      if (data.status === 'failed') {
        toast.error(data.error ?? 'Discord rejected the message')
      } else {
        setDraft('')
      }
      await load()
    } finally {
      setSending(false)
    }
  }

  if (messages === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }

  return (
    <Card>
      <CardContent className="flex h-[60vh] flex-col gap-3 p-4">
        {!linked ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            This athlete has no linked Discord account yet. Link them from the Inbox, then you can
            DM back and forth here.
          </p>
        ) : (
          <>
            <div className="flex-1 space-y-2 overflow-y-auto pr-1">
              {messages.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No messages yet. Say hi — your athlete can reply straight from Discord DMs.
                </p>
              ) : (
                messages.map((m) => (
                  <div
                    key={m.id}
                    className={cn('flex', m.direction === 'out' ? 'justify-end' : 'justify-start')}
                  >
                    <div
                      className={cn(
                        'max-w-[75%] rounded-2xl px-3 py-2 text-sm',
                        m.direction === 'out'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-foreground',
                        m.status === 'failed' && 'ring-1 ring-destructive',
                      )}
                    >
                      <p className="whitespace-pre-wrap break-words">{m.content}</p>
                      <p
                        className={cn(
                          'mt-0.5 text-[10px]',
                          m.direction === 'out' ? 'text-primary-foreground/70' : 'text-muted-foreground',
                        )}
                      >
                        {m.timestamp.slice(0, 16).replace('T', ' ')}
                        {m.status === 'failed' ? ' · not delivered' : ''}
                      </p>
                    </div>
                  </div>
                ))
              )}
              <div ref={endRef} />
            </div>

            <div className="flex items-end gap-2 border-t pt-3">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Message your athlete on Discord…"
                rows={2}
                className="flex-1 resize-none"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
              />
              <Button onClick={send} disabled={sending || !draft.trim()}>
                <Send className="h-4 w-4" /> {sending ? 'Sending…' : 'Send'}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
