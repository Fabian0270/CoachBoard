import { useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card'
import { Button } from './ui/button'
import { useToast } from './ui/toast'
import { useConfirm } from './ui/confirm-dialog'
import { humanBytes } from '../lib/formatBytes'
import { AlertTriangle, Download, FolderOpen, RotateCcw, Save } from 'lucide-react'

interface BackupInfo {
  databasePath: string
  databaseBytes: number
  backupDir: string
  backupCount: number
  latestBackup: string | null
  restorePending: boolean
}

interface SystemPaths {
  dataDir: string
  canReveal: boolean
}

/**
 * "Where is my data and how do I back it up?" — the question every coach asks of
 * a local-first app, which until now had no answer inside the app at all.
 */
export default function DataSettingsCard() {
  const toast = useToast()
  const confirm = useConfirm()
  const fileInput = useRef<HTMLInputElement>(null)

  const [info, setInfo] = useState<BackupInfo | null>(null)
  const [paths, setPaths] = useState<SystemPaths | null>(null)
  const [busy, setBusy] = useState<'backup' | 'export' | 'restore' | null>(null)

  const load = async () => {
    try {
      const [infoRes, pathsRes] = await Promise.all([
        fetch('/api/backup/info'),
        fetch('/api/system/paths'),
      ])
      if (infoRes.ok) setInfo(await infoRes.json())
      if (pathsRes.ok) setPaths(await pathsRes.json())
    } catch {
      toast.error('Could not read your data settings.')
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const backUpNow = async () => {
    setBusy('backup')
    try {
      const res = await fetch('/api/backup/now', { method: 'POST' })
      if (!res.ok) throw new Error((await res.json()).error ?? 'Backup failed')
      toast.success('Backup saved.')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Backup failed.')
    } finally {
      setBusy(null)
    }
  }

  /** Download the database through the browser so the coach picks where it lands. */
  const saveCopy = async () => {
    setBusy('export')
    try {
      const res = await fetch('/api/backup/export')
      if (!res.ok) throw new Error('Export failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `coachboard-backup-${new Date().toISOString().slice(0, 10)}.sqlite`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      toast.error('Could not save a copy of your data.')
    } finally {
      setBusy(null)
    }
  }

  const chooseRestoreFile = async (file: File) => {
    const ok = await confirm({
      title: 'Restore from this backup?',
      description:
        `This replaces everything currently in CoachBoard with the contents of "${file.name}". ` +
        'Your current database is kept alongside it, and nothing changes until you restart the app.',
      confirmLabel: 'Restore',
      destructive: true,
    })
    if (!ok) return

    setBusy('restore')
    try {
      const res = await fetch('/api/backup/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: await file.arrayBuffer(),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Restore failed')
      toast.success('Restore ready. Close and reopen CoachBoard to apply it.')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Restore failed.')
    } finally {
      setBusy(null)
    }
  }

  const cancelRestore = async () => {
    try {
      await fetch('/api/backup/restore', { method: 'DELETE' })
      toast.info('Restore cancelled.')
      await load()
    } catch {
      toast.error('Could not cancel the restore.')
    }
  }

  const openFolder = async () => {
    try {
      await fetch('/api/system/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'data' }),
      })
    } catch {
      toast.error('Could not open the folder.')
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your data</CardTitle>
        <CardDescription>
          Everything in CoachBoard — athletes, programs, payments and settings — is stored in a
          single file on this computer. It is never uploaded anywhere.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {info?.restorePending && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="space-y-2">
              <p>
                A restore is ready. Close and reopen CoachBoard to apply it — nothing has changed
                yet.
              </p>
              <Button size="sm" variant="outline" onClick={cancelRestore}>
                Cancel restore
              </Button>
            </div>
          </div>
        )}

        <dl className="space-y-2 text-sm">
          <div>
            <dt className="text-muted-foreground">Data folder</dt>
            <dd className="break-all font-mono text-xs">{paths?.dataDir ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Database size</dt>
            <dd>{info ? humanBytes(info.databaseBytes) : '—'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Automatic backups</dt>
            <dd>
              {info?.backupCount
                ? `${info.backupCount} kept, newest ${info.latestBackup}`
                : 'None yet — one is taken each time you open the app.'}
            </dd>
          </div>
        </dl>

        <div className="flex flex-wrap gap-2">
          <Button onClick={saveCopy} disabled={busy !== null}>
            <Download className="h-4 w-4" />
            {busy === 'export' ? 'Preparing…' : 'Save a copy'}
          </Button>
          <Button variant="outline" onClick={backUpNow} disabled={busy !== null}>
            <Save className="h-4 w-4" />
            {busy === 'backup' ? 'Backing up…' : 'Back up now'}
          </Button>
          <Button
            variant="outline"
            onClick={() => fileInput.current?.click()}
            disabled={busy !== null}
          >
            <RotateCcw className="h-4 w-4" />
            {busy === 'restore' ? 'Checking…' : 'Restore from a file'}
          </Button>
          {paths?.canReveal && (
            <Button variant="outline" onClick={openFolder}>
              <FolderOpen className="h-4 w-4" />
              Open data folder
            </Button>
          )}
        </div>

        <input
          ref={fileInput}
          type="file"
          accept=".sqlite,.db,application/octet-stream"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            // Reset so picking the same file twice still fires a change event.
            e.target.value = ''
            if (file) void chooseRestoreFile(file)
          }}
        />
      </CardContent>
    </Card>
  )
}
