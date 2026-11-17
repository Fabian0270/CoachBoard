import { useEffect, useState } from 'react'
import { Copy, Loader2, Send } from 'lucide-react'
import type { DiscordUserItem } from 'coachboard-shared/discord'
import { Button } from '../ui/button'
import { useToast } from '../ui/toast'
import { getList } from '../../lib/api'

// ---------------------------------------------------------------------------
// The feedback message for the athlete (BP36): written from the set's numbers
// with the coach's note, editable, then copied or sent. Sending goes to the
// athlete's linked Discord account as a DM with the bar path image (D61) and
// is only offered when the athlete is linked.
// ---------------------------------------------------------------------------

export default function FeedbackPanel({ draft, athleteId, athleteName, makeImage }: {
  /** The message as written from the numbers; the coach edits from here. */
  draft: string
  athleteId: string | null
  athleteName: string | null
  /** The bar path image to send with it (BP24), or null when there is no picture. */
  makeImage: (() => Promise<Blob>) | null
}) {
  const toast = useToast()
  const [text, setText] = useState(draft)
  const [edited, setEdited] = useState(false)
  const [linked, setLinked] = useState(false)
  const [sending, setSending] = useState(false)

  // Follows the numbers until the coach starts typing.
  useEffect(() => { if (!edited) setText(draft) }, [draft, edited])

  useEffect(() => {
    if (!athleteId) { setLinked(false); return }
    let cancelled = false
    getList<DiscordUserItem>('/api/discord/users')
      .then((users) => !cancelled && setLinked(users.some((u) => u.athleteId === athleteId)))
      // Discord not set up, or unreadable: no Send button, Copy still works.
      .catch(() => !cancelled && setLinked(false))
    return () => { cancelled = true }
  }, [athleteId])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Message copied.')
    } catch {
      toast.error('The message could not be copied.')
    }
  }

  const send = async () => {
    if (!athleteId) return
    setSending(true)
    try {
      const body = makeImage ? await makeImage() : null
      const res = await fetch(
        body
          ? `/api/discord/athletes/${encodeURIComponent(athleteId)}/dm-image?message=${encodeURIComponent(text)}`
          : `/api/discord/athletes/${encodeURIComponent(athleteId)}/dm`,
        body
          ? { method: 'POST', headers: { 'Content-Type': 'image/png' }, body }
          : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text }) },
      )
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(detail.error ?? `Discord said ${res.status}`)
      }
      toast.success(`Sent to ${athleteName ?? 'the athlete'} on Discord.`)
    } catch (err) {
      toast.error(`Could not send it. ${err instanceof Error ? err.message : ''}`.trim())
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="space-y-2 rounded-md border p-4" aria-label="Feedback for the athlete">
      <h2 className="text-sm font-medium">Feedback for {athleteName ?? 'the athlete'}</h2>
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setEdited(true) }}
        rows={4}
        maxLength={2000}
        className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
        aria-label="Feedback message"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={copy}>
          <Copy className="h-4 w-4" /> Copy
        </Button>
        {linked && (
          <Button size="sm" onClick={send} disabled={sending || !text.trim()} title={makeImage ? 'Sends the message with the bar path image as a direct message' : 'Sends the message as a direct message'}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send to Discord
          </Button>
        )}
        {!linked && athleteId && (
          <span className="text-xs text-muted-foreground">Link {athleteName ?? 'the athlete'} to a Discord account to send it from here.</span>
        )}
      </div>
    </section>
  )
}
