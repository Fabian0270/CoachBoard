import { useEffect, useMemo, useRef, useState } from 'react'
import { Film, FolderOpen, Search, Upload } from 'lucide-react'
import type { DiscordMediaItem } from 'coachboard-shared/discord'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

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
  | { kind: 'local'; name: string; url: string; file: File }

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

  useEffect(() => {
    let cancelled = false
    fetch('/api/discord/media?filter=all&limit=200')
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((data: { items: DiscordMediaItem[] }) => {
        if (!cancelled) setItems(data.items.filter((m) => m.isVideo && m.playable))
      })
      .catch(() => !cancelled && setItems([]))
    return () => {
      cancelled = true
    }
  }, [])

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
        <Button variant="outline" onClick={() => fileRef.current?.click()}>
          <FolderOpen className="h-4 w-4" /> Choose a video
        </Button>
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

        {items === null && <p className="text-sm text-muted-foreground">Loading videos…</p>}

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
      </div>
    </div>
  )
}
