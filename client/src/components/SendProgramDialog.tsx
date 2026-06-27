import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Textarea } from './ui/textarea'
import { useToast } from './ui/toast'
import { Send, AlertTriangle } from 'lucide-react'

interface Props {
  programId: string
  programName: string
  athleteId: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function SendProgramDialog({ programId, programName, athleteId, open, onOpenChange }: Props) {
  const toast = useToast()
  const [loadingMeta, setLoadingMeta] = useState(true)
  const [configured, setConfigured] = useState(false)
  const [athleteMissingEmail, setAthleteMissingEmail] = useState(false)
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoadingMeta(true)
    setAthleteMissingEmail(false)
    setSubject(`Your CoachBoard program: ${programName}`)
    setBody(
      `Hi,\n\nHere's your program "${programName}" attached as an Excel sheet. ` +
        `Fill in the Load Used and Last Set RPE columns as you train, then send it back to me.\n\nThanks!`,
    )

    const settingsP = fetch('/api/settings/email')
      .then((r) => r.json())
      .then((s) => setConfigured(!!s?.configured))
      .catch(() => setConfigured(false))

    const athleteP = athleteId
      ? fetch(`/api/athletes/${athleteId}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((a) => {
            const email = a?.email?.trim() ?? ''
            setTo(email)
            setAthleteMissingEmail(!email)
          })
          .catch(() => { setTo(''); setAthleteMissingEmail(true) })
      : Promise.resolve(setAthleteMissingEmail(true))

    Promise.all([settingsP, athleteP]).finally(() => setLoadingMeta(false))
  }, [open, athleteId, programName])

  const send = async () => {
    const recipient = to.trim()
    if (!recipient) { toast.error('Enter a recipient email address'); return }
    setSending(true)
    try {
      const res = await fetch(`/api/programs/${programId}/send-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: recipient, subject: subject.trim(), body }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) {
        toast.success(`Program sent to ${recipient}`)
        onOpenChange(false)
      } else {
        toast.error(data.error ?? 'Failed to send the program')
      }
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Email program to athlete</DialogTitle>
          <DialogDescription>
            Sends the same Excel sheet as “Save to PC”, straight from your email account.
          </DialogDescription>
        </DialogHeader>

        {loadingMeta ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !configured ? (
          <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Email isn’t set up yet. Add your email account in{' '}
              <Link to="/settings" className="font-medium underline underline-offset-2" onClick={() => onOpenChange(false)}>
                Settings
              </Link>{' '}
              first, then come back to send.
            </span>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="to">To</Label>
              <Input id="to" type="email" value={to} placeholder="athlete@example.com" onChange={(e) => setTo(e.target.value)} />
              {athleteMissingEmail && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  This athlete has no email on file — enter one above (or add it on their profile).
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="subject">Subject</Label>
              <Input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="body">Message</Label>
              <Textarea id="body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
            </div>
            <p className="text-xs text-muted-foreground">📎 {programName}.xlsx will be attached.</p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>Cancel</Button>
          <Button onClick={send} disabled={sending || loadingMeta || !configured}>
            <Send className="h-4 w-4" />
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
