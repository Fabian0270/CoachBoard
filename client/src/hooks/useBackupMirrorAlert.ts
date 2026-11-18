import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useToast } from '../components/ui/toast'
import { getJson } from '../lib/api'
import type { MirrorStatus } from '../components/BackupMirrorSection'

// D93: when a backup could not be copied to the second folder, say so ONCE —
// not at every launch while the drive stays unplugged. Settings keeps showing
// it until a copy works again. Remembered per failure: a new failure after a
// copy that worked is a new message.

const SEEN_KEY = 'coachboard.backupMirror.toldFailingSince'
const CHECK_EVERY_MS = 30 * 60 * 1000

const seen = (): string | null => { try { return localStorage.getItem(SEEN_KEY) } catch { return null } }
const remember = (v: string) => { try { localStorage.setItem(SEEN_KEY, v) } catch { /* private window */ } }

export function useBackupMirrorAlert(): void {
  const toast = useToast()
  // In a ref: the router hands out a new navigate on every page change, which
  // would otherwise restart the checks each time the coach clicks somewhere.
  const nav = useNavigate()
  const navigate = useRef(nav)
  navigate.current = nav
  const told = useRef<string | null>(seen())

  useEffect(() => {
    let stopped = false
    const check = () => {
      getJson<MirrorStatus>('/api/backup/mirror').then((s) => {
        if (stopped || !s.dir || !s.failingSince || told.current === s.failingSince) return
        told.current = s.failingSince
        remember(s.failingSince)
        toast.error(`Your backup was made on this computer, but not copied to your second folder. ${s.error ?? ''}`.trim(), {
          action: { label: 'Open Settings', onClick: () => navigate.current('/settings?tab=data') },
          duration: 15000,
        })
      }, () => { /* the next check tries again */ })
    }
    // A moment after start: the launch backup's copy runs while the app opens.
    const first = window.setTimeout(check, 5000)
    const timer = window.setInterval(check, CHECK_EVERY_MS)
    return () => { stopped = true; window.clearTimeout(first); window.clearInterval(timer) }
  }, [toast])
}
