import { Film, Image as ImageIcon, FileWarning, HardDriveDownload } from 'lucide-react'
import type { DiscordMediaItem } from 'coachboard-shared/discord'
import { cn } from '../../lib/utils'

/**
 * Static preview tile. Images render inline (lazy); videos deliberately show
 * an icon tile — mounting dozens of <video> elements exhausts decoder handles,
 * so the actual <video> only ever lives inside MediaPlayerDialog.
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

  return (
    <button
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
      {playable && !item.isVideo ? (
        <img
          src={`/api/discord/media/${item.id}/file`}
          alt={item.filename}
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <>
          {item.downloadStatus === 'failed' ? (
            <FileWarning className="h-6 w-6 text-destructive" />
          ) : item.downloadStatus === 'pending' ? (
            <HardDriveDownload className="h-6 w-6 animate-pulse" />
          ) : item.isVideo ? (
            <Film className="h-6 w-6" />
          ) : (
            <ImageIcon className="h-6 w-6" />
          )}
          <span className="max-w-full truncate px-2 text-[10px]">{item.filename}</span>
        </>
      )}
    </button>
  )
}
