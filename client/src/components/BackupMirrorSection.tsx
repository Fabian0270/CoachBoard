import { useEffect, useState } from 'react'
import { AlertTriangle, CloudUpload, FolderInput, X } from 'lucide-react'
import { Button } from './ui/button'
import { useToast } from './ui/toast'
import { errorMessage, getJson, sendJson } from '../lib/api'

/** "19 Nov 2026, 09:14" in the coach's own format. */
const formatDateTime = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

// The second backup folder (N4, D91–D94). Off until the coach picks a folder;
// then every backup is also copied there, the 5 newest kept. CoachBoard never
// uploads anything: a cloud folder is synced by its own app.

export interface MirrorStatus {
  dir: string | null
  lastCopiedAt: string | null
  lastCopiedFile: string | null
  error: string | null
  failingSince: string | null
  canPick: boolean
}

export default function BackupMirrorSection({ refreshKey = 0 }: { refreshKey?: number }) {
  const toast = useToast()
  const [status, setStatus] = useState<MirrorStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getJson<MirrorStatus>('/api/backup/mirror').then(setStatus, () => setStatus(null))
  }, [refreshKey])

  const pick = async () => {
    setBusy(true)
    try {
      const res = await sendJson<{ cancelled: boolean; status: MirrorStatus }>('POST', '/api/backup/mirror/pick')
      setStatus(res.status)
      if (res.cancelled) return
      if (res.status.error) toast.error(`The folder is set, but the first copy failed: ${res.status.error}`)
      else toast.success('From now on every backup is also copied there.')
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    setBusy(true)
    try {
      setStatus(await sendJson<MirrorStatus>('DELETE', '/api/backup/mirror'))
      toast.info('Backups are no longer copied there. The copies already in that folder are left as they are.')
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (!status) return null

  return (
    <section aria-labelledby="mirror-heading" className="space-y-2 rounded-md border border-border p-3">
      <h3 id="mirror-heading" className="flex items-center gap-2 text-sm font-medium">
        <CloudUpload className="h-4 w-4 text-primary" />Second backup folder
        {!status.dir && <span className="text-xs font-normal text-muted-foreground">Off</span>}
      </h3>

      {status.dir ? (
        <>
          <p className="break-all font-mono text-xs">{status.dir}</p>
          {status.error ? (
            <p className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Not copied since {formatDateTime(status.failingSince ?? '')}: {status.error} The backups on
                this computer are still made.
                {status.lastCopiedAt ? ` Last copied ${formatDateTime(status.lastCopiedAt)}.` : ''}
              </span>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {status.lastCopiedAt
                ? `Last copied ${formatDateTime(status.lastCopiedAt)}. The 5 newest are kept there.`
                : 'Nothing copied yet — the next backup goes there too.'}
            </p>
          )}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Keep a copy of every backup in a second folder as well — one that OneDrive, Dropbox or Google
          Drive syncs, or a USB drive — so your data is safe even if this computer is lost. The 5 newest
          are kept there.
        </p>
      )}

      {/* D94: said where the folder is chosen. */}
      <p className="text-xs text-muted-foreground">
        Backups contain your athletes’ data. In a cloud folder, that service stores it too.
      </p>

      {status.canPick ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={pick} disabled={busy}>
            <FolderInput className="h-4 w-4" />
            {status.dir ? 'Change folder…' : 'Choose folder…'}
          </Button>
          {status.dir && (
            <Button size="sm" variant="ghost" onClick={stop} disabled={busy}>
              <X className="h-4 w-4" />Stop copying
            </Button>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">A folder can be chosen in the CoachBoard app.</p>
      )}
    </section>
  )
}
