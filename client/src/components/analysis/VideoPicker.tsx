import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, Film, FolderOpen, Search, Upload, Video } from 'lucide-react'
import type { DiscordMediaItem } from 'coachboard-shared/discord'
import type { VbtLift } from 'coachboard-shared/vbt'
import CameraCapture from './CameraCapture'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { errorMessage, getJson } from '../../lib/api'

/**
 * Where a clip being analysed came from.
 *
 * A local file is played from an object URL — the analyser runs entirely in the
 * renderer, so nothing is uploaded merely to look at a lift. The `File` is kept
 * alongside it because saving an analysis now stores the video too, and by that
 * point the object URL is only a handle to bytes the page can no longer read.
 * Nothing is copied anywhere until the coach actually saves.
 */
export type AnalysisSource =
  | { kind: 'discord'; item: DiscordMediaItem }
  | {
      kind: 'local'; name: string; url: string; file: File
      /** Picked on the camera screen before recording (BP41, D103), for the analysis to start with. */
      preset?: { athleteId: string | null; lift: VbtLift }
    }

/** Media rows read from the inbox at a time. */
const PAGE = 200

function fmtDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Chooses a video to analyse, from disk or from an athlete's synced history.
 *
 * Disk is offered first and unconditionally. Bar-path analysis is useful on any
 * footage — a coach filming in the gym on their own phone, a lift sent over
 * WhatsApp — so requiring the Discord integration first would put a general
 * tool behind an unrelated setup step.
 */
export default function VideoPicker({ onPick }: { onPick: (source: AnalysisSource) => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [items, setItems] = useState<DiscordMediaItem[] | null>(null)
  const [query, setQuery] = useState('')
  const [dragging, setDragging] = useState(false)
  /** Recording a set from a camera instead (BP41). */
  const [camera, setCamera] = useState(false)

  /** Why the synced videos could not be read. Never shown as "no videos yet" (BP6). */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  /**
   * How far into the inbox has been read, and how much there is (BP19). The
   * list used to stop at the newest 200 with no hint that there was more.
   * Counted in media rows, images included, since that is what the server pages.
   */
  const [read, setRead] = useState(0)
  const [total, setTotal] = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoadError(null)
    getJson<{ items: DiscordMediaItem[]; total: number }>(`/api/discord/media?filter=all&limit=${PAGE}`)
      .then((data) => {
        if (cancelled) return
        setItems(data.items.filter((m) => m.isVideo && m.playable))
        setRead(data.items.length)
        setTotal(data.total ?? data.items.length)
      })
      .catch((err) => {
        if (cancelled) return
        setItems(null)
        setLoadError(errorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  const showMore = async () => {
    setLoadingMore(true)
    try {
      const data = await getJson<{ items: DiscordMediaItem[]; total: number }>(`/api/discord/media?filter=all&limit=${PAGE}&offset=${read}`)
      setItems((prev) => [...(prev ?? []), ...data.items.filter((m) => m.isVideo && m.playable)])
      setRead((n) => n + data.items.length)
      setTotal((t) => data.total ?? t)
    } catch (err) {
      setLoadError(errorMessage(err))
    } finally {
      setLoadingMore(false)
    }
  }

  const takeFile = (file: File | undefined) => {
    if (!file) return
    onPick({ kind: 'local', name: file.name, url: URL.createObjectURL(file), file })
  }

  const filtered = useMemo(() => {
    if (!items) return []
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((m) =>
      [m.athleteName, m.authorUsername, m.filename, m.caption]
        .filter(Boolean)
        .some((s) => s!.toLowerCase().includes(q)),
    )
  }, [items, query])

  if (camera) {
    return (
      <CameraCapture
        onCancel={() => setCamera(false)}
        onDone={({ file, athleteId, lift }) =>
          onPick({ kind: 'local', name: file.name, url: URL.createObjectURL(file), file, preset: { athleteId, lift } })
        }
      />
    )
  }

  return (
    <div className="space-y-6">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          takeFile(e.dataTransfer.files?.[0])
        }}
        className={`flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
          dragging ? 'border-primary bg-primary/5' : 'border-border'
        }`}
      >
        <Upload className="h-8 w-8 text-muted-foreground" />
        <div>
          <p className="font-medium">Analyse a video from your computer</p>
          <p className="text-sm text-muted-foreground">
            Drop a file here, or choose one. Nothing is copied anywhere unless you save the
            analysis.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="outline" onClick={() => fileRef.current?.click()}>
            <FolderOpen className="h-4 w-4" /> Choose a video
          </Button>
          {/* For coaching in person: film the set here and analyse it straight after. */}
          <Button variant="outline" onClick={() => setCamera(true)}>
            <Video className="h-4 w-4" /> Record with a camera
          </Button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="video/*"
          className="hidden"
          onChange={(e) => takeFile(e.target.files?.[0])}
        />
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Or pick one an athlete sent</h2>
          {!!items?.length && (
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search athlete or file…"
                className="h-9 w-56 pl-8"
              />
            </div>
          )}
        </div>

        {loadError ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-destructive">Could not load the synced videos. {loadError}</span>
            <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>
            <span className="text-muted-foreground">A file from your computer still works.</span>
          </div>
        ) : items === null && <p className="text-sm text-muted-foreground">Loading videos…</p>}

        {items?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No synced videos yet. Connect Discord in Settings to have athletes' videos appear here
            automatically — or just use a file from your computer above.
          </p>
        )}

        {!!filtered.length && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {filtered.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onPick({ kind: 'discord', item })}
                className="group overflow-hidden rounded-md border text-left transition-colors hover:border-primary/60"
              >
                <div className="relative flex h-24 w-full items-center justify-center bg-muted/40">
                  {item.thumbUrl ? (
                    <img
                      src={item.thumbUrl}
                      alt={item.filename}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <Film className="h-6 w-6 text-muted-foreground" />
                  )}
                  {/* Already analysed (BP19): working through an inbox means
                      knowing which clips are done. */}
                  {item.analysisCount > 0 && (
                    <span
                      className="absolute left-1 top-1 flex items-center gap-0.5 rounded bg-primary px-1 text-[10px] font-medium text-primary-foreground"
                      title={item.analysisCount === 1 ? 'A saved analysis uses this clip' : `${item.analysisCount} saved analyses use this clip`}
                    >
                      <Check className="h-3 w-3" /> Done
                    </span>
                  )}
                  {item.durationMs != null && item.durationMs > 0 && (
                    <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] font-medium text-white">
                      {fmtDuration(item.durationMs)}
                    </span>
                  )}
                </div>
                <div className="p-2">
                  <p className="truncate text-sm font-medium">
                    {item.athleteName ?? item.authorUsername}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {item.postedAt.slice(0, 10)}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}

        {items !== null && items.length > 0 && filtered.length === 0 && (
          <p className="text-sm text-muted-foreground">Nothing matches that search.</p>
        )}

        {items !== null && read < total && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>The newest {read} of {total} synced files{query.trim() ? ' — the search only looks through these' : ''}.</span>
            <Button size="sm" variant="outline" onClick={showMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Show older ones'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
