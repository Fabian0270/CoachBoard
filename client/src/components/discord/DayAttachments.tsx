import { useState } from 'react'
import { Button } from '../ui/button'
import { useToast } from '../ui/toast'
import { Paperclip } from 'lucide-react'
import MediaThumb from './MediaThumb'
import MediaPlayerDialog from './MediaPlayerDialog'
import type { DiscordMediaItem } from 'coachboard-shared/discord'

/**
 * Attachment strip inside the program day editor: the form-check videos the
 * athlete sent for this training day. Detach returns a video to the inbox
 * review queue without deleting anything.
 */
export default function DayAttachments({
  items,
  onDetached,
}: {
  items: DiscordMediaItem[]
  onDetached: () => void
}) {
  const toast = useToast()
  const [playing, setPlaying] = useState<DiscordMediaItem | null>(null)

  if (items.length === 0) return null

  const detach = async (item: DiscordMediaItem) => {
    const res = await fetch(`/api/discord/media/${item.id}/workout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workoutId: null }),
    })
    if (res.ok) {
      toast.success('Detached — the video is back in the Discord inbox')
      onDetached()
    }
  }

  return (
    <div className="space-y-2 border-t pt-3">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Paperclip className="h-4 w-4" />
        Athlete videos ({items.length})
      </p>
      <div className="flex flex-wrap gap-3">
        {items.map((m) => (
          <div key={m.id} className="w-32 space-y-1">
            <MediaThumb item={m} onOpen={setPlaying} onDeleted={onDetached} />
            {m.caption && (
              <p className="truncate text-[10px] text-muted-foreground" title={m.caption}>
                “{m.caption}”
              </p>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-full text-[10px] text-muted-foreground"
              onClick={() => detach(m)}
            >
              Detach
            </Button>
          </div>
        ))}
      </div>
      <MediaPlayerDialog item={playing} onClose={() => setPlaying(null)} onDeleted={onDetached} />
    </div>
  )
}
