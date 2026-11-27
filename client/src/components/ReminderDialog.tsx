import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, Send } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Textarea } from './ui/textarea'
import { useToast } from './ui/toast'
import { errorMessage, getJson } from '../lib/api'

// ---------------------------------------------------------------------------
// A payment reminder (S5, D87): the drafted email, editable, sent only when
// the coach clicks Send — to the athlete, over the coach's own email setup.
// ---------------------------------------------------------------------------

interface Draft {
  paymentId: string
  athleteName: string
  to: string | null
  subject: string
  body: string
  status: 'due_soon' | 'overdue'
  remindedAt: string | null
  emailConfigured: boolean
}

export default function ReminderDialog({
  paymentId,
  athleteId,
  onClose,
  onSent,
}: {
  paymentId: string | null
  athleteId: string | null
  onClose: () => void
  onSent: () => void
}) {
  const toast = useToast()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (!paymentId) return
    setDraft(null)
    setError(null)
    getJson<Draft>(`/api/payments/${encodeURIComponent(paymentId)}/reminder`)
      .then((d) => { setDraft(d); setSubject(d.subject); setBody(d.body) })
      .catch((e) => setError(errorMessage(e)))
  }, [paymentId])

  const send = async () => {
    if (!paymentId) return
    setSending(true)
    try {
      const res = await fetch(`/api/payments/${encodeURIComponent(paymentId)}/reminder`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject, body }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? `the server said ${res.status}`)
      }
      toast.success(`Reminder sent to ${draft?.athleteName ?? 'the athlete'}`)
      onSent()
      onClose()
    } catch (e) {
      toast.error(`Could not send the reminder. ${errorMessage(e)}`)
    } finally {
      setSending(false)
    }
  }

  const blocked = draft && (!draft.to || !draft.emailConfigured)

  return (
    <Dialog open={!!paymentId} onOpenChange={(v) => { if (!v && !sending) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Payment reminder{draft ? ` to ${draft.athleteName}` : ''}</DialogTitle>
          <DialogDescription>Read it through and change anything; nothing is sent until you click Send.</DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-destructive">Could not prepare the reminder. {error}</p>
        ) : !draft ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm">
              <span className="text-muted-foreground">To </span>
              {draft.to ?? <span className="text-destructive">no email address on file</span>}
            </p>
            {draft.remindedAt && (
              <p className="text-xs text-warning">Last reminder sent {draft.remindedAt.slice(0, 10)}.</p>
            )}
            <Input aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            <Textarea aria-label="Message" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
            {!draft.to && athleteId && (
              <p className="text-sm text-muted-foreground">
                Add {draft.athleteName}’s email on <Link to={`/athletes/${athleteId}`} className="underline">their page</Link> to send this.
              </p>
            )}
            {draft.to && !draft.emailConfigured && (
              <p className="text-sm text-muted-foreground">
                Set up your email in <Link to="/settings?tab=email" className="underline">Settings</Link> to send reminders.
              </p>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={sending}>Cancel</Button>
          <Button size="sm" onClick={() => void send()} disabled={sending || !draft || !!blocked || !subject.trim() || !body.trim()}>
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
