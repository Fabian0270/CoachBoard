import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { InboxCounts } from 'coachboard-shared/discord'

/**
 * Nav-badge count for the Discord inbox. Polls every 60s and re-checks on
 * navigation; the endpoint answers instantly from the local DB (zeros when
 * Discord isn't configured), so this is cheap even offline.
 */
export function useDiscordInboxCounts(): InboxCounts {
  const [counts, setCounts] = useState<InboxCounts>({ unmatched: 0, unreviewed: 0 })
  const location = useLocation()

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch('/api/discord/media/counts')
        if (res.ok && !cancelled) setCounts(await res.json())
      } catch {
        /* offline — keep the last value */
      }
    }
    void load()
    const interval = setInterval(() => void load(), 60_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [location.pathname])

  return counts
}
