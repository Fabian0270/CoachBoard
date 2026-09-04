import { Pause, Play, Square } from 'lucide-react'
import { DISCORD_MAX_BYTES, formatBytes, formatDuration, sizeStatus } from './recorder.core'

// ---------------------------------------------------------------------------
// The only control that stays on screen while recording.
//
// It IS in the recording when the coach records CoachBoard or a whole screen.
// That is accepted rather than worked around: keeping it out would mean a
// second always-on-top window, and this app has no IPC to drive one. A small
// pill that reads as a recording indicator is an honest thing to leave in the
// frame — and it tells the athlete the coach knows they are being recorded.
// ---------------------------------------------------------------------------

interface Props {
  elapsedMs: number
  bytes: number
  paused: boolean
  onPause(): void
  onResume(): void
  onStop(): void
}

export default function RecordingPill({
  elapsedMs,
  bytes,
  paused,
  onPause,
  onResume,
  onStop,
}: Props) {
  const status = sizeStatus(bytes)

  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
      <div className="flex items-center gap-3 rounded-full border border-border bg-card/95 px-4 py-2 shadow-lg backdrop-blur">
        <span
          className={`h-2.5 w-2.5 rounded-full ${
            paused ? 'bg-muted-foreground' : 'animate-pulse bg-red-500'
          }`}
        />
        <span className="font-mono text-sm tabular-nums">{formatDuration(elapsedMs)}</span>

        {/* Measured against Discord because it is the tightest cap and the one a
            coach is most likely to be aiming for. */}
        <span
          className={`font-mono text-xs tabular-nums ${
            status === 'over'
              ? 'text-destructive'
              : status === 'near'
                ? 'text-amber-500'
                : 'text-muted-foreground'
          }`}
          title={
            status === 'ok'
              ? 'Small enough to send on Discord'
              : status === 'near'
                ? `Approaching Discord's ${formatBytes(DISCORD_MAX_BYTES)} limit`
                : `Too big for Discord — email or save it instead`
          }
        >
          {formatBytes(bytes)}
        </span>

        <div className="mx-1 h-5 w-px bg-border" />

        <button
          onClick={paused ? onResume : onPause}
          className="rounded-full p-1.5 hover:bg-accent"
          title={paused ? 'Resume' : 'Pause'}
        >
          {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
        </button>
        <button
          onClick={onStop}
          className="rounded-full bg-destructive p-1.5 text-destructive-foreground hover:bg-destructive/90"
          title="Stop recording"
        >
          <Square className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
