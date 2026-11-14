import { useEffect, useRef, useState } from 'react'
import { Pause, Play, Square } from 'lucide-react'
import { formatDuration } from './recorder.core'
import {
  HEARTBEAT_MS,
  openControlsChannel,
  type ControlsMessage,
} from './controlsChannel'
import type { RecorderState } from './recorder.core'

// ---------------------------------------------------------------------------
// The floating recording controls: the whole page of the small always-on-top
// window the main process opens when the coach records another window or the
// whole screen (see openRecorderControls in electron/src/main.ts).
//
// It holds no recorder of its own. It shows what the recorder in the main
// window publishes and sends pause/resume/stop back over the same channel.
// The window is excluded from screen capture, so the athlete never sees it.
// ---------------------------------------------------------------------------

/** Missing this many heartbeats in a row means the main window is gone. */
const LOST_AFTER_MS = HEARTBEAT_MS * 6

export default function FloatingControls() {
  const [state, setState] = useState<RecorderState | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const channelRef = useRef<BroadcastChannel | null>(null)
  const lastHeard = useRef(Date.now())

  useEffect(() => {
    const channel = openControlsChannel()
    channelRef.current = channel
    if (!channel) {
      window.close()
      return
    }
    const onMessage = (event: MessageEvent<ControlsMessage>) => {
      const message = event.data
      if (message.type !== 'state') return
      lastHeard.current = Date.now()
      // Anything past capturing — finishing, reviewing, idle — is the main
      // window's to show. The bar's job is done.
      if (message.state !== 'recording' && message.state !== 'paused' && message.state !== 'countdown') {
        window.close()
        return
      }
      setState(message.state)
      setElapsedMs(message.elapsedMs)
    }
    channel.addEventListener('message', onMessage)
    channel.postMessage({ type: 'hello' } satisfies ControlsMessage)
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastHeard.current > LOST_AFTER_MS) window.close()
    }, HEARTBEAT_MS)
    return () => {
      window.clearInterval(watchdog)
      channel.removeEventListener('message', onMessage)
      channel.close()
    }
  }, [])

  const send = (action: 'pause' | 'resume' | 'stop') =>
    channelRef.current?.postMessage({ type: 'command', action } satisfies ControlsMessage)

  const paused = state === 'paused'
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

  return (
    <div
      // The whole bar drags the window; the buttons opt out so they still click.
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      className="flex h-screen w-screen select-none items-center gap-3 rounded-full border border-border bg-card px-4 text-foreground"
    >
      <span
        className={`h-2.5 w-2.5 shrink-0 rounded-full ${paused ? 'bg-muted-foreground' : 'animate-pulse bg-red-500'}`}
      />
      <span className="font-mono text-sm tabular-nums">{state ? formatDuration(elapsedMs) : '—'}</span>
      <span className="truncate text-xs text-muted-foreground">
        {paused ? 'Paused' : 'Recording'}
      </span>
      <div className="ml-auto flex items-center gap-1" style={noDrag}>
        <button
          type="button"
          onClick={() => send(paused ? 'resume' : 'pause')}
          disabled={!state}
          className="rounded-full p-1.5 hover:bg-accent disabled:opacity-50"
          title={paused ? 'Resume' : 'Pause'}
          aria-label={paused ? 'Resume recording' : 'Pause recording'}
        >
          {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
        </button>
        <button
          type="button"
          onClick={() => send('stop')}
          disabled={!state}
          className="rounded-full bg-destructive p-1.5 text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
          title="Stop recording"
          aria-label="Stop recording"
        >
          <Square className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
