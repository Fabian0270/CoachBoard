import { useEffect, useRef, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card'
import { Button } from './ui/button'
import { useToast } from './ui/toast'
import { useConfirm } from './ui/confirm-dialog'
import { humanBytes } from '../lib/formatBytes'
import BackupMirrorSection from './BackupMirrorSection'
import { getJson } from '../lib/api'
import { localToday } from '../lib/dates'
import { AlertTriangle, Download, FolderOpen, RotateCcw, Save, Undo2 } from 'lucide-react'

interface BackupInfo {
  databasePath: string
  databaseBytes: number
  backupDir: string
  backupCount: number
  latestBackup: string | null
  restorePending: boolean
  /** The last restore replaced a database that can still be brought back. */
  canUndoRestore?: boolean
  /** Set when a restored database could not be used and was rolled back. */
  restoreFailure?: { at: string; message: string; previousKept: boolean } | null
}

interface SystemPaths {
  dataDir: string
  canReveal: boolean
}

interface StorageItem { bytes: number; files: number }
interface StorageBreakdown {
  database: StorageItem
  excelTemplates: StorageItem
  backups: StorageItem
  discordMedia: StorageItem
  analysisVideos: StorageItem
  totalBytes: number
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * Where the disk space goes. The only figure the app used to show was Discord
 * media, and only on the Dashboard once Discord was set up — so a data folder
 * that had grown to gigabytes gave no clue why.
 */
function StorageBreakdownList({ storage }: { storage: StorageBreakdown }) {
  const rows: Array<[string, string]> = [
    [
      'Database',
      humanBytes(storage.database.bytes) +
        (storage.excelTemplates.files > 0
          ? ` — including ${count(storage.excelTemplates.files, 'imported Excel file', 'imported Excel files')} (${humanBytes(storage.excelTemplates.bytes)})`
          : ''),
    ],
    ['Backups', `${humanBytes(storage.backups.bytes)} — ${count(storage.backups.files, 'copy', 'copies')}`],
    ['Discord videos', `${humanBytes(storage.discordMedia.bytes)} — ${count(storage.discordMedia.files, 'file', 'files')}`],
    ['Bar-path clips', `${humanBytes(storage.analysisVideos.bytes)} — ${count(storage.analysisVideos.files, 'clip', 'clips')}`],
  ]
  return (
    <table className="mt-1 text-xs">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <td className="pr-4 text-muted-foreground">{label}</td>
            <td>{value}</td>
          </tr>
        ))}
        <tr className="font-medium">
          <td className="pr-4 pt-1">Total</td>
          <td className="pt-1">{humanBytes(storage.totalBytes)}</td>
        </tr>
      </tbody>
    </table>
  )
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
  const [storage, setStorage] = useState<StorageBreakdown | null>(null)
  const [busy, setBusy] = useState<'backup' | 'export' | 'restore' | 'undo' | null>(null)
  const [mirrorRefresh, setMirrorRefresh] = useState(0)

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
    getJson<StorageBreakdown>('/api/system/storage').then(setStorage, () => setStorage(null))
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const backUpNow = async () => {
    setBusy('backup')
    try {
      const res = await fetch('/api/backup/now', { method: 'POST' })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Backup failed')
      const mirror = body.mirror as { dir: string | null; error: string | null } | undefined
      if (mirror?.dir && mirror.error) toast.error(`Backup saved on this computer, but not copied to your second folder: ${mirror.error}`)
      else toast.success(mirror?.dir ? 'Backup saved, and copied to your second folder.' : 'Backup saved.')
      setMirrorRefresh((n) => n + 1)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Backup failed.')
    } finally {
      setBusy(null)
    }
  }

  /** Download the backup through the browser so the coach picks where it lands. */
  const saveCopy = async () => {
    setBusy('export')
    try {
      const res = await fetch('/api/backup/export')
      if (!res.ok) throw new Error('Export failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `coachboard-backup-${localToday()}.zip`
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
        `This replaces your athletes, programs, payments and settings with the contents of ` +
        `"${file.name}". Saved video clips and synced Discord media are not part of a backup, ` +
        'so anything on this computer now stays as it is. Your current database is kept ' +
        'alongside the restored one, and nothing changes until you restart the app.',
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
      toast.success(
        body.settings?.length
          ? 'Restore ready, including your email and Discord settings. Close and reopen CoachBoard to apply it.'
          : 'Restore ready. Close and reopen CoachBoard to apply it.',
      )
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Restore failed.')
    } finally {
      setBusy(null)
    }
  }

  /** Back to the database the last restore replaced — applied on restart, like a restore. */
  const undoRestore = async () => {
    const ok = await confirm({
      title: 'Undo the last restore?',
      description:
        'This brings back your athletes, programs, payments and settings as they were just ' +
        'before you last restored a backup. Anything you changed since that restore is replaced. ' +
        'Nothing changes until you restart the app.',
      confirmLabel: 'Undo restore',
      destructive: true,
    })
    if (!ok) return
    setBusy('undo')
    try {
      const res = await fetch('/api/backup/restore/undo', { method: 'POST' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? 'Could not undo the restore.')
      toast.success('Undo ready. Close and reopen CoachBoard to apply it.')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not undo the restore.')
    } finally {
      setBusy(null)
    }
  }

  const dismissRestoreFailure = async () => {
    try {
      await fetch('/api/backup/restore-failed', { method: 'DELETE' })
      await load()
    } catch {
      toast.error('Could not dismiss that notice.')
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
    <Card data-tour="your-data">
      <CardHeader>
        <CardTitle>Your data</CardTitle>
        <CardDescription>
          Your athletes, programs and payments live in a single database file on this computer,
          alongside your email and Discord settings. A backup holds all of it. CoachBoard never
          uploads it anywhere; you can choose a second folder for the backups below.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* A restored database that could not be opened is rolled back at
            launch. Said here, because otherwise the coach restores a backup,
            restarts, and finds their data unchanged with no idea why. */}
        {info?.restoreFailure && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="space-y-2">
              <p>
                Your last restore could not be used ({info.restoreFailure.message}).{' '}
                {info.restoreFailure.previousKept
                  ? 'Your previous data was put back, so nothing was lost.'
                  : 'CoachBoard started with an empty database instead.'}{' '}
                The file that failed is kept in your data folder as{' '}
                <span className="font-mono text-xs">coachboard.sqlite.failed-restore</span>.
              </p>
              <Button size="sm" variant="outline" onClick={dismissRestoreFailure}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {info?.restorePending && (
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
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
            <dt className="text-muted-foreground">Space used</dt>
            <dd>
              {storage ? (
                <StorageBreakdownList storage={storage} />
              ) : (
                // The breakdown is extra detail; if it cannot be read, the
                // database size from the backup status still answers the basics.
                info ? humanBytes(info.databaseBytes) : '—'
              )}
            </dd>
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

        {/* Says what a backup does NOT hold. The card used to claim it covered
            "everything", which meant a coach restoring after a disk failure
            discovered the gap at the worst possible moment. */}
        <p className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">A backup holds</span> your athletes,
          programs, payments, Excel styles, and your email and Discord settings.{' '}
          <span className="font-medium text-foreground">It does not hold</span> your saved video
          clips, synced Discord media, or screen recordings — those can run to many gigabytes, so
          copy the data folder itself if you need them. Saved passwords only work again on this
          computer; restoring onto a new one asks you to enter them once more.
        </p>

        {/* Re-read after "Back up now", which also copies there. */}
        <BackupMirrorSection refreshKey={mirrorRefresh} />

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
          {info?.canUndoRestore && !info.restorePending && (
            <Button variant="outline" onClick={undoRestore} disabled={busy !== null}>
              <Undo2 className="h-4 w-4" />
              {busy === 'undo' ? 'Checking…' : 'Undo last restore'}
            </Button>
          )}
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
          // .sqlite/.db stay accepted: backups taken before the archive format
          // existed are still valid and the server still reads them.
          accept=".zip,.sqlite,.db,application/zip,application/octet-stream"
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
