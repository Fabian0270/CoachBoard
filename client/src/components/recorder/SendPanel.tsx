import { useEffect, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { blockedReason, deliveryFitness } from './recorder.core'

// ---------------------------------------------------------------------------
// Sending a finished recording to an athlete, by DM or by email.
//
// Both paths pick the athlete first, because the two things the coach needs —
// a linked Discord account, an email address — are properties of the athlete,
// and finding out which one is missing AFTER writing a message is the annoying
// version of this screen.
// ---------------------------------------------------------------------------

interface Athlete {
  id: string
  name: string
  email: string | null
}

interface Props {
  recordingId: string
  bytes: number
  channel: 'discord' | 'email'
  onSent(): void
  onCancel(): void
}

export default function SendPanel({ recordingId, bytes, channel, onSent, onCancel }: Props) {
  const [athletes, setAthletes] = useState<Athlete[] | null>(null)
  const [athleteId, setAthleteId] = useState('')
  const [message, setMessage] = useState(
    channel === 'discord' ? 'Here are some notes on your last session.' : '',
  )
  const [subject, setSubject] = useState('A video from your coach')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/athletes')
      .then((res) => res.json())
      .then(setAthletes)
      .catch(() => setAthletes([]))
  }, [])

  // Picking an athlete fills the address in, the way SendProgramDialog does.
  useEffect(() => {
    const athlete = athletes?.find((a) => a.id === athleteId)
    if (athlete?.email) setTo(athlete.email)
  }, [athleteId, athletes])

  const tooBig = !deliveryFitness(bytes)[channel]
  const selected = athletes?.find((a) => a.id === athleteId) ?? null
  const missingEmail = channel === 'email' && !!selected && !selected.email

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      const res =
        channel === 'discord'
          ? await fetch(`/api/recorder/recordings/${recordingId}/discord`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ athleteId, message }),
            })
          : await fetch(`/api/recorder/recordings/${recordingId}/email`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ to, subject, body: message }),
            })
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? 'Send failed')
      onSent()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send it.')
    } finally {
      setBusy(false)
    }
  }

  const canSend =
    !busy && !tooBig && (channel === 'discord' ? !!athleteId : /.+@.+\..+/.test(to) && !!subject)

  return (
    <div className="mt-4 space-y-3 rounded-md border border-border p-4">
      <h3 className="text-sm font-medium">
        {channel === 'discord' ? 'Send on Discord' : 'Email it'}
      </h3>

      {tooBig ? (
        <p className="text-sm text-destructive">{blockedReason(channel, bytes)}</p>
      ) : (
        <>
          <div>
            <Label htmlFor="rec-athlete">Athlete</Label>
            <select
              id="rec-athlete"
              value={athleteId}
              onChange={(e) => setAthleteId(e.target.value)}
              className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">Choose an athlete…</option>
              {(athletes ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>

          {channel === 'email' && (
            <>
              <div>
                <Label htmlFor="rec-to">To</Label>
                <Input
                  id="rec-to"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="athlete@example.com"
                  className="mt-1"
                />
                {missingEmail && (
                  <p className="mt-1 text-xs text-amber-500">
                    {selected?.name} has no email saved — type one, or add it on their page.
                  </p>
                )}
              </div>
              <div>
                <Label htmlFor="rec-subject">Subject</Label>
                <Input
                  id="rec-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  className="mt-1"
                />
              </div>
            </>
          )}

          <div>
            <Label htmlFor="rec-message">Message</Label>
            <textarea
              id="rec-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-md border border-input bg-background p-2 text-sm"
            />
          </div>
        </>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={send} disabled={!canSend}>
          {busy ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </div>
  )
}
