import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Loader2, Smartphone } from 'lucide-react'
import type { VbtLift } from 'coachboard-shared/vbt'
import { Button } from '../ui/button'
import { errorMessage, getJson, getList, sendJson } from '../../lib/api'
import { humanBytes } from '../../lib/formatBytes'
import type { CameraTake } from './CameraCapture'

// ---------------------------------------------------------------------------
// Send a set from a phone (BP41 part b, D100, D104–D106).
//
// A QR code opens a small page on the phone; the phone's own camera app films
// the set and the clip comes over the Wi-Fi. One clip per scan (D104): when it
// arrives it opens for analysis, and the link closes. The link is open only
// while this screen is. The lift is picked on the phone before filming (D127)
// and comes over with the clip; the analysis goes by it.
// ---------------------------------------------------------------------------

interface Status {
  active: boolean
  /** This visit's link (not the code), for closing it and no newer one. */
  id: string | null
  /** When the code changes next, while no phone has opened the page (D130). */
  rotatesAt: number | null
  rotateEveryMs: number | null
  /** The phone that opened the page, once one has (D130). */
  phone: string | null
  url: string | null
  otherUrls: string[]
  qrSvg: string | null
  receiving: number | null
  clip: { name: string; bytes: number; lift: VbtLift } | null
  closedBecause: string | null
}

/** Seconds until the code changes, rolling over to the next interval once `at` has passed. */
export function secondsToNextCode(at: number, everyMs: number | null, now: number): number {
  let left = at - now
  if (everyMs && everyMs > 0 && left <= 0) left += Math.ceil((-left + 1) / everyMs) * everyMs
  return Math.max(0, Math.ceil(left / 1000))
}

/**
 * "New code in 0:42", on a clock of its own. It used to redraw only with the
 * once-a-second status check, which runs a little late now and then, so a
 * number stuck for two seconds or was skipped; and at each switch it sat on
 * 0:00 until the next check. Now it ticks five times a second and rolls over
 * by itself.
 */
function NextCode({ at, everyMs }: { at: number; everyMs: number | null }) {
  const [secs, setSecs] = useState(() => secondsToNextCode(at, everyMs, Date.now()))
  useEffect(() => {
    const tick = () => setSecs(secondsToNextCode(at, everyMs, Date.now()))
    tick()
    const timer = window.setInterval(tick, 200)
    return () => window.clearInterval(timer)
  }, [at, everyMs])
  return (
    <p className="num text-center text-xs text-muted-foreground">
      New code in {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
    </p>
  )
}

export default function PhoneLink({ onDone, onCancel }: { onDone: (take: CameraTake) => void; onCancel: () => void }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState(false)
  const [athletes, setAthletes] = useState<{ id: string; name: string }[]>([])
  const [athleteId, setAthleteId] = useState('')
  const [attempt, setAttempt] = useState(0)
  const choice = useRef({ athleteId })
  choice.current = { athleteId }
  /** Set once the clip has been handed over, so leaving does not close a link that already ended. */
  const handedOver = useRef(false)

  useEffect(() => { getList<{ id: string; name: string }>('/api/athletes').then(setAthletes, () => setAthletes([])) }, [])

  // Open the link, then watch for the clip. Closed again when leaving.
  useEffect(() => {
    let stopped = false
    setError(null)
    setStatus(null)
    // A new code and key every time this screen opens.
    const opened = sendJson<Status>('POST', '/api/phone-link')
    opened
      .then((s) => { if (!stopped) setStatus(s) })
      .catch((err) => { if (!stopped) setError(errorMessage(err)) })

    let busy = false
    const timer = window.setInterval(async () => {
      if (stopped || busy) return
      busy = true
      try {
        const s = await getJson<Status>('/api/phone-link')
        if (stopped) return
        setStatus(s)
        if (s.clip) {
          window.clearInterval(timer)
          setOpening(true)
          const res = await fetch('/api/phone-link/clip')
          if (!res.ok) throw new Error('The clip arrived but could not be read.')
          const blob = await res.blob()
          const file = new File([blob], s.clip.name, { type: blob.type || 'video/mp4' })
          handedOver.current = true
          await sendJson('POST', '/api/phone-link/claim').catch(() => {})
          onDone({ file, athleteId: choice.current.athleteId || null, lift: s.clip.lift })
        }
      } catch (err) {
        if (!stopped) { setOpening(false); setError(errorMessage(err)) }
      } finally {
        busy = false
      }
    }, 1000)

    return () => {
      stopped = true
      window.clearInterval(timer)
      // Only this visit's link, by its id: reopened quickly, this goodbye can
      // land after the next visit's link opened, and must not close that one.
      if (!handedOver.current) {
        void opened
          .then((s) => { if (s.id) return sendJson('DELETE', `/api/phone-link?link=${encodeURIComponent(s.id)}`) })
          .catch(() => {})
      }
    }
    // onDone is read once, when the clip arrives; re-running for it would reopen the link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt])

  const qrSrc = status?.qrSvg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(status.qrSvg)}` : null
  const closed = status && !status.active
  const connected = !!status?.phone

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={opening}>
          <ArrowLeft className="h-4 w-4" />Back
        </Button>
        <h2 className="flex items-center gap-2 text-base font-semibold"><Smartphone className="h-4 w-4 text-primary" />Send a set from your phone</h2>
      </div>

      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Athlete (optional)</span>
          <select value={athleteId} onChange={(e) => setAthleteId(e.target.value)} className="max-w-[14rem] rounded-md border bg-background px-2 py-1 text-sm">
            <option value="">Choose later</option>
            {athletes.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
      </div>

      {error ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span role="alert" className="text-destructive">{error}</span>
          <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
        </div>
      ) : closed ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span role="status">{status.closedBecause ?? 'The phone link is closed.'}</span>
          <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>Start again</Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-6 rounded-lg border p-4">
          <div className="shrink-0 space-y-1.5">
            <div className="flex h-56 w-56 items-center justify-center rounded-md bg-white p-2">
              {connected ? (
                // The code has done its job: it only works on the phone that opened it now.
                <Smartphone aria-label="Phone connected" className="h-16 w-16 text-black/70" />
              ) : qrSrc ? (
                <img src={qrSrc} alt="QR code for your phone" className="h-full w-full" />
              ) : (
                <Loader2 className="h-6 w-6 animate-spin text-black/40 motion-reduce:animate-none" />
              )}
            </div>
            {!connected && status?.rotatesAt && <NextCode at={status.rotatesAt} everyMs={status.rotateEveryMs} />}
          </div>
          <div className="min-w-[16rem] flex-1 space-y-3 text-sm">
            {opening || status?.receiving != null || status?.clip ? (
              <p role="status" className="flex items-center gap-2 font-medium">
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                {opening ? 'Opening the clip…' : `Receiving the clip… ${humanBytes(status?.receiving ?? status?.clip?.bytes ?? 0)}`}
              </p>
            ) : connected ? (
              <div className="space-y-1.5">
                <p role="status" className="font-medium text-success">Phone connected ({status?.phone}). Film the set and send it.</p>
                {/* D130: if this appears before you scanned, it isn't your phone. */}
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  Not your phone?
                  <Button size="sm" variant="outline" className="h-7" onClick={() => setAttempt((n) => n + 1)}>Start again with a new code</Button>
                </p>
              </div>
            ) : (
              <p role="status" className="font-medium">Waiting for your phone…</p>
            )}
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>Connect the phone to the same Wi-Fi as this computer.</li>
              <li>Point the phone's camera at the code and open the link.</li>
              <li>Tap the lift, then <span className="text-foreground">Record a set</span>, film, and use the video. It opens here for analysis.</li>
            </ol>
            <p className="text-xs text-muted-foreground">
              Film in 1080p to send in seconds — 4K takes much longer over Wi-Fi. One clip per scan: for the
              next set, come back here and scan again.
            </p>
            <p className="text-xs text-muted-foreground">
              The first time, Windows may ask whether CoachBoard can use the network: allow it on private
              networks. Nothing else of CoachBoard is reachable from the phone, and the link closes when you
              leave this screen.
            </p>
            {status?.url && !connected && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Phone won't connect?</summary>
                <p className="mt-1">Type this into the phone's browser instead:</p>
                <p className="break-all font-mono text-foreground">{status.url}</p>
                {status.otherUrls.length > 0 && (
                  <>
                    <p className="mt-1">Or, if this computer has more than one network, one of these:</p>
                    {status.otherUrls.map((u) => <p key={u} className="break-all font-mono">{u}</p>)}
                  </>
                )}
                <p className="mt-1">Some gym and guest Wi-Fi networks keep devices from reaching each other; a phone hotspot or home Wi-Fi then works instead.</p>
              </details>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
