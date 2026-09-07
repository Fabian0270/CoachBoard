import { useState } from 'react'
import { Check, Download, Mail, MessageSquare, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import SendPanel from './SendPanel'
import { blockedReason, deliveryFitness, formatBytes } from './recorder.core'

// ---------------------------------------------------------------------------
// Watch it back, then decide what happens to it.
//
// The working copy is deleted when this closes, so the dialog says so plainly
// rather than leaving the coach to find out. Sending deletes it immediately;
// saving to PC deliberately does not, because the download and the delete would
// race — the launch sweep collects it instead.
//
// Which is why the closing action is named for what the coach just did. Once
// they have their own copy, "Discard" describes the temporary file they never
// knew existed, and reads as if it will destroy the video they just saved.
// ---------------------------------------------------------------------------

interface Props {
  recordingId: string
  bytes: number
  error: string | null
  onSaved(): void
  onSent(): void
  onDiscard(): void
}

export default function ReviewDialog({
  recordingId,
  bytes,
  error,
  onSaved,
  onSent,
  onDiscard,
}: Props) {
  const [sending, setSending] = useState<'discord' | 'email' | null>(null)
  /** True once the coach has their own copy, which changes what closing means. */
  const [kept, setKept] = useState(false)
  const fitness = deliveryFitness(bytes)
  const src = `/api/recorder/recordings/${recordingId}/file`

  const saveToPc = () => {
    // A plain download: Electron shows the OS Save As dialog, so the coach picks
    // where it lands. No dialog API and no IPC needed for this at all.
    const a = document.createElement('a')
    a.href = `${src}?download=1`
    a.download = ''
    document.body.appendChild(a)
    a.click()
    a.remove()
    setKept(true)
    onSaved()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-card p-6 shadow-lg">
        <h2 className="text-lg font-semibold">Your recording</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {formatBytes(bytes)}. Check it before you send it — everything on screen was captured.
        </p>

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

        <video src={src} controls className="mt-4 max-h-[50vh] w-full rounded bg-black" />

        <div className="mt-5 flex flex-wrap gap-2">
          <Button onClick={saveToPc}>
            <Download className="h-4 w-4" />
            Save to PC
          </Button>
          <Button
            variant={sending === 'discord' ? 'secondary' : 'outline'}
            onClick={() => setSending(sending === 'discord' ? null : 'discord')}
          >
            <MessageSquare className="h-4 w-4" />
            Send on Discord
          </Button>
          <Button
            variant={sending === 'email' ? 'secondary' : 'outline'}
            onClick={() => setSending(sending === 'email' ? null : 'email')}
          >
            <Mail className="h-4 w-4" />
            Email it
          </Button>
          {/* Same action either way — it always removes the working copy. Only
              the name changes, because after a save that copy is not the
              coach's video, and calling it "Discard" implies it is. */}
          <Button variant="ghost" className="ml-auto" onClick={onDiscard}>
            {kept ? (
              <>
                <Check className="h-4 w-4" />
                Done
              </>
            ) : (
              <>
                <Trash2 className="h-4 w-4" />
                Discard
              </>
            )}
          </Button>
        </div>

        {sending && (
          <SendPanel
            recordingId={recordingId}
            bytes={bytes}
            channel={sending}
            onSent={onSent}
            onCancel={() => setSending(null)}
          />
        )}

        {/* Said up front rather than at the point of failure: a coach who has
            just recorded four minutes should not learn about the cap by
            filling in a message and pressing Send. */}
        {!sending && !fitness.discord && (
          <p className="mt-3 text-xs text-amber-500">{blockedReason('discord', bytes)}</p>
        )}

        <p className="mt-4 text-xs text-muted-foreground">
          {kept
            ? 'Saved to your PC. Closing removes CoachBoard’s working copy — your saved file is untouched.'
            : 'This recording is deleted when you close this window unless you save it.'}
        </p>
      </div>
    </div>
  )
}
