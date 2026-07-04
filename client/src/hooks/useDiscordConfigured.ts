import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { PublicDiscordSettings } from 'coachboard-shared/discord'

/**
 * Whether the Discord integration is connected. Used to gate nav items, the
 * dashboard storage tile, and the athlete Videos/Messages tabs. Re-checks on
 * navigation so connecting/disconnecting reflects without a reload. Answers
 * from the local DB (no network call to Discord), so it's cheap even offline.
 */
export function useDiscordConfigured(): { configured: boolean; loading: boolean } {
  const [configured, setConfigured] = useState(false)
  const [loading, setLoading] = useState(true)
  const location = useLocation()

  useEffect(() => {
    let cancelled = false
    fetch('/api/discord/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((s: PublicDiscordSettings | null) => {
        if (!cancelled) setConfigured(!!s?.configured)
      })
      .catch(() => {
        /* offline — keep the last value */
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [location.pathname])

  return { configured, loading }
}
