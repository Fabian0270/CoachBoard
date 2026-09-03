import { useEffect, useRef, useState } from 'react'
import type { DiscordMediaItem } from 'coachboard-shared/discord'
import { requestThumbnail, releaseThumbnail } from '../lib/thumbnailQueue'

/**
 * Gives a video tile its poster frame, generating one on first sight if the
 * server doesn't have it yet.
 *
 * Generation is gated on the tile actually being scrolled into view, so opening
 * an athlete with 200 videos doesn't queue 200 decodes for rows the coach never
 * looks at. The queue itself is what enforces one-at-a-time (see thumbnailQueue).
 */
export function useThumbnail(item: DiscordMediaItem): {
  ref: React.RefObject<HTMLElement | null>
  src: string | null
  durationMs: number | null
} {
  const ref = useRef<HTMLElement | null>(null)
  const [generated, setGenerated] = useState<{ src: string; durationMs: number | null } | null>(null)

  // Already have one, or already know we can't make one.
  const needsGeneration =
    item.isVideo && item.playable && !item.thumbUrl && item.thumbStatus === null

  useEffect(() => {
    if (!needsGeneration) return
    const el = ref.current
    if (!el) return

    let cancelled = false
    let claimed = false

    const claim = () => {
      if (claimed) return
      claimed = true
      requestThumbnail(item.id).then(({ result, durationMs }) => {
        if (!cancelled && result === 'ok') {
          setGenerated({ src: `/api/discord/media/${item.id}/thumb`, durationMs })
        }
      })
    }

    // rootMargin gives the queue a head start on the next row, so a steady
    // scroll usually finds the thumbnail already there.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          claim()
          observer.disconnect()
        }
      },
      { rootMargin: '200px' },
    )
    observer.observe(el)

    return () => {
      cancelled = true
      observer.disconnect()
      if (claimed) releaseThumbnail(item.id)
    }
  }, [item.id, needsGeneration])

  return {
    ref,
    src: item.thumbUrl ?? generated?.src ?? null,
    // Prefer what we just measured: the caller's props predate this capture.
    durationMs: item.durationMs ?? generated?.durationMs ?? null,
  }
}
