import type { RecorderState } from './recorder.core'

// ---------------------------------------------------------------------------
// The link between the recorder (in CoachBoard's main window) and the floating
// controls bar (a separate always-on-top window the main process opens when
// the coach records anything other than CoachBoard itself).
//
// Both are pages of this app on the same origin, so a BroadcastChannel reaches
// across the two windows with no IPC or preload — which this app deliberately
// has none of. The recorder is the only source of truth; the bar only shows
// what it is told and sends commands back.
// ---------------------------------------------------------------------------

export const CONTROLS_CHANNEL = 'coachboard-recorder-controls'

/** The recorder publishes at least this often while capturing, so the bar can tell it is still there. */
export const HEARTBEAT_MS = 500

export type ControlsMessage =
  | { type: 'state'; state: RecorderState; elapsedMs: number; bytes: number }
  | { type: 'command'; action: 'pause' | 'resume' | 'stop' }
  /** Sent by the bar when it opens, asking for the current state straight away. */
  | { type: 'hello' }

export function openControlsChannel(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CONTROLS_CHANNEL)
}
