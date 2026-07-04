import { Trash2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useConfirm } from '../ui/confirm-dialog'
import { useToast } from '../ui/toast'
import MediaTile from './MediaTile'
import type { DiscordMediaItem } from 'coachboard-shared/discord'

/**
 * A media tile with an optional hover delete button. Kept as a sibling overlay
 * (not nested in the tile's button) to avoid invalid nested-interactive markup.
 * Deleting removes the file + record entirely (confirmed first).
 */
export default function MediaThumb({
  item,
  onOpen,
  onDeleted,
  className,
}: {
  item: DiscordMediaItem
  onOpen: (m: DiscordMediaItem) => void
  /** Provide to enable the delete affordance; called after a successful delete. */
  onDeleted?: () => void
  className?: string
}) {
  const confirm = useConfirm()
  const toast = useToast()

  const del = async () => {
    const ok = await confirm({
      title: 'Delete this video?',
      description: 'This permanently removes the file and its record from CoachBoard to free up space. This cannot be undone.',
      destructive: true,
      confirmLabel: 'Delete',
    })
    if (!ok) return
    const res = await fetch(`/api/discord/media/${item.id}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success('Video deleted')
      onDeleted?.()
    } else {
      toast.error('Failed to delete the video')
    }
  }

  return (
    <div className={cn('group relative', className)}>
      <MediaTile item={item} onOpen={onOpen} />
      {onDeleted && (
        <button
          type="button"
          onClick={del}
          title="Delete video"
          className="absolute right-1 top-1 hidden rounded bg-black/60 p-1 text-white hover:bg-red-600 group-hover:block"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
