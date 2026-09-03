import { Film, Image as ImageIcon, FileWarning, HardDriveDownload, Play } from 'lucide-react'
import type { DiscordMediaItem } from 'coachboard-shared/discord'
import { cn } from '../../lib/utils'
import { useThumbnail } from '../../hooks/useThumbnail'

/** mm:ss for the corner pill — the photo-app convention for "this is a video". */
function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Static preview tile. Images render inline (lazy); videos render a generated
 * poster frame, falling back to an icon while one is being made or when this
 * machine can't decode the file.
 *
 * The actual <video> still only ever lives inside MediaPlayerDialog — mounting
 * dozens of them exhausts decoder handles. Poster frames are produced one at a
 * time by a shared queue (see lib/thumbnailQueue) for that same reason.
 */
export default function MediaTile({
  item,
  onOpen,
  className,
}: {
  item: DiscordMediaItem
  onOpen: (item: DiscordMediaItem) => void
  className?: string
}) {
  const playable = item.playable
  const { ref, src: thumbSrc, durationMs } = useThumbnail(item)

  const preview = item.isVideo ? thumbSrc : playable ? `/api/discord/media/${item.id}/file` : null

  return (
    <button
      ref={ref as React.RefObject<HTMLButtonElement>}
      type="button"
      onClick={() => playable && onOpen(item)}
      disabled={!playable}
      className={cn(
        'relative flex h-24 w-32 shrink-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-md border bg-muted/40 text-muted-foreground transition-colors',
        playable ? 'hover:border-primary/50 hover:text-foreground' : 'opacity-60',
        className,
      )}
      title={item.filename}
    >
      {playable && preview ? (
        <>
          <img
            src={preview}
            alt={item.filename}
            loading="lazy"
            className="absolute inset-0 h-full w-full object-cover"
          />
          {item.isVideo && (
            // The scrim disc is what keeps the glyph readable — a bare white
            // triangle disappears into a bright gym frame.
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-black/45 ring-1 ring-white/25">
                <Play className="h-3.5 w-3.5 translate-x-[1px] fill-white text-white" />
              </span>
            </span>
          )}
          {durationMs != null && durationMs > 0 && (
            <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[10px] font-medium text-white">
              {formatDuration(durationMs)}
            </span>
          )}
        </>
      ) : (
        <>
          {item.downloadStatus === 'failed' ? (
            <FileWarning className="h-6 w-6 text-destructive" />
          ) : item.downloadStatus === 'pending' ? (
            <HardDriveDownload className="h-6 w-6 animate-pulse" />
          ) : item.isVideo ? (
            <Film className={cn('h-6 w-6', item.thumbStatus === null && 'animate-pulse')} />
          ) : (
            <ImageIcon className="h-6 w-6" />
          )}
          <span className="max-w-full truncate px-2 text-[10px]">{item.filename}</span>
        </>
      )}
    </button>
  )
}
