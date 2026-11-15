import { useEffect, useRef, useState } from 'react'
import { Check, Download, Loader2, Mail, MessageSquare, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import SendPanel from './SendPanel'
import RecordingEditor from './RecordingEditor'
import type { BubbleCorner } from './compositor'
import { blockedReason, deliveryFitness, formatBytes } from './recorder.core'
import {
  needsExport,
  placementFromCorner,
  type Trim,
  type WebcamPlacement,
} from './recordingEdit'
import { ExportCancelled, discardExport, exportRecording } from './recordingExport'

// ---------------------------------------------------------------------------
// Watch it back, adjust it, then decide what happens to it.
//
// The recording arrives as a screen file and — when the coach used one — a
// separate webcam file. Here the coach places the webcam circle (or hides it)
// and trims the ends; saving or sending first builds the edited video, quickly
// and entirely on this computer (see recordingExport.ts).
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
  /** Size of the recording as captured. */
  bytes: number
  error: string | null
  /** Ms the webcam file starts after the screen file; null when there is no webcam. */
  cameraOffsetMs: number | null
  /** The corner the webcam starts in. */
  corner: BubbleCorner
  onSaved(): void
  onSent(): void
  onDiscard(): void
}

/** One string per distinct edit, to tell whether the built video is still the one on screen. */
const signatureOf = (placement: WebcamPlacement, trim: Trim): string =>
  JSON.stringify([
    placement.hidden,
    placement.hidden ? 0 : Math.round(placement.x * 1000),
    placement.hidden ? 0 : Math.round(placement.y * 1000),
    placement.hidden ? 0 : Math.round(placement.size * 1000),
    Math.round(trim.start * 100),
    Math.round(trim.end * 100),
  ])

export default function ReviewDialog({
  recordingId,
  bytes,
  error,
  cameraOffsetMs,
  corner,
  onSaved,
  onSent,
  onDiscard,
}: Props) {
  const hasCamera = cameraOffsetMs !== null
  const [sending, setSending] = useState<'discord' | 'email' | null>(null)
  /** True once the coach has their own copy, which changes what closing means. */
  const [kept, setKept] = useState(false)

  // --- the edit -------------------------------------------------------------
  const [placement, setPlacement] = useState<WebcamPlacement>(() => placementFromCorner(corner, 16, 9))
  const [trim, setTrim] = useState<Trim>({ start: 0, end: 0 })
  const [duration, setDuration] = useState(0)
  const placedForFrame = useRef(false)

  // --- the built video --------------------------------------------------------
  /** The edit the server's current `final` was built from; null when it has none. */
  const [builtFor, setBuiltFor] = useState<string | null>(null)
  /** Size of what would be saved or sent right now. */
  const [deliverBytes, setDeliverBytes] = useState(bytes)
  const [progress, setProgress] = useState<number | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const exporting = progress !== null

  const ready = duration > 0
  const signature = signatureOf(placement, trim)
  const mustBuild = ready && needsExport({ hasCamera, placement, trim, duration })
  /** What saving or sending would deliver is exactly what the preview shows. */
  const upToDate = mustBuild ? builtFor === signature : builtFor === null

  // A send panel is for one specific video. Any further edit makes it stale.
  useEffect(() => {
    if (!upToDate) setSending(null)
  }, [upToDate])

  // Cancel a running export if the dialog goes away.
  useEffect(() => () => abortRef.current?.abort(), [])

  /**
   * Makes the server's deliverable match the preview: builds the edited video
   * when one is needed, drops a stale one when it is not. False if it could not.
   */
  const prepare = async (): Promise<boolean> => {
    if (!ready) return false
    if (upToDate) return true
    setExportError(null)
    try {
      if (!mustBuild) {
        const info = await discardExport(recordingId)
        setBuiltFor(null)
        setDeliverBytes(info.bytes)
        return true
      }
      const controller = new AbortController()
      abortRef.current = controller
      setProgress(0)
      const built = await exportRecording({
        recordingId,
        camera: hasCamera && !placement.hidden ? { placement, offsetMs: cameraOffsetMs } : null,
        trim: { start: trim.start, end: trim.end },
        onProgress: setProgress,
        signal: controller.signal,
      })
      setBuiltFor(signature)
      setDeliverBytes(built.bytes)
      return true
    } catch (err) {
      setBuiltFor(null)
      if (!(err instanceof ExportCancelled)) {
        setExportError(
          `The video could not be built${err instanceof Error && err.message ? `: ${err.message}` : '.'} Your recording is untouched — try again.`,
        )
      }
      return false
    } finally {
      abortRef.current = null
      setProgress(null)
    }
  }

  const src = `/api/recorder/recordings/${recordingId}/file`

  const saveToPc = async () => {
    if (!(await prepare())) return
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

  const openSend = async (channel: 'discord' | 'email') => {
    if (sending === channel) {
      setSending(null)
      return
    }
    // Built first, so the panel can judge the size of the video actually sent.
    if (await prepare()) setSending(channel)
  }

  const fitness = deliveryFitness(deliverBytes)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-border bg-card p-6 shadow-lg">
        <h2 className="text-lg font-semibold">Your recording</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Check it before you send it — everything on screen was captured.
          {hasCamera ? ' Drag the webcam where it is not in the way, and' : ' You can'} trim the start and end
          with the handles on the timeline.
        </p>

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

        <RecordingEditor
          recordingId={recordingId}
          cameraOffsetMs={cameraOffsetMs}
          placement={placement}
          onPlacement={setPlacement}
          trim={trim}
          onTrim={setTrim}
          duration={duration}
          onDuration={(seconds) => {
            setDuration(seconds)
            setTrim({ start: 0, end: seconds })
          }}
          onFrameSize={(width, height) => {
            // The default corner depends on the frame's real shape, known only now.
            if (placedForFrame.current) return
            placedForFrame.current = true
            setPlacement(placementFromCorner(corner, width, height))
          }}
          disabled={exporting}
        />

        {exporting && (
          <div className="mt-4 rounded-md border border-border p-3">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Building your video… {Math.round((progress ?? 0) * 100)}%</span>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={() => abortRef.current?.abort()}>
                Cancel
              </Button>
            </div>
            <div
              className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((progress ?? 0) * 100)}
              aria-label="Building your video"
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
            </div>
          </div>
        )}
        {exportError && <p className="mt-3 text-sm text-destructive">{exportError}</p>}

        <div className="mt-5 flex flex-wrap gap-2">
          <Button onClick={() => void saveToPc()} disabled={exporting || !ready}>
            <Download className="h-4 w-4" />
            Save to PC
          </Button>
          <Button
            variant={sending === 'discord' ? 'secondary' : 'outline'}
            onClick={() => void openSend('discord')}
            disabled={exporting || !ready}
          >
            <MessageSquare className="h-4 w-4" />
            Send on Discord
          </Button>
          <Button
            variant={sending === 'email' ? 'secondary' : 'outline'}
            onClick={() => void openSend('email')}
            disabled={exporting || !ready}
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
            bytes={deliverBytes}
            channel={sending}
            onSent={onSent}
            onCancel={() => setSending(null)}
          />
        )}

        {/* Said up front rather than at the point of failure: a coach who has
            just recorded four minutes should not learn about the cap by
            filling in a message and pressing Send. Only once the size is that
            of the video that would actually go out. */}
        {!sending && upToDate && !fitness.discord && (
          <p className="mt-3 text-xs text-amber-500">{blockedReason('discord', deliverBytes)}</p>
        )}

        <p className="mt-4 text-xs text-muted-foreground">
          {upToDate ? `${formatBytes(deliverBytes)}. ` : ''}
          {kept
            ? 'Saved to your PC. Closing removes CoachBoard’s working copy — your saved file is untouched.'
            : 'This recording is deleted when you close this window unless you save it.'}
        </p>
      </div>
    </div>
  )
}
