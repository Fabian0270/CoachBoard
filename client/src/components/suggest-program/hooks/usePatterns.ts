import { useEffect, useState } from 'react'
import type { DetectedPattern } from 'coachboard-shared'
import { getList } from '../../../lib/api'

// Detected periodization patterns (Feature 5d) — fetched once per open, shown
// as named shortcuts on the goal step alongside the generic goals.
export function usePatterns(open: boolean) {
  const [patterns, setPatterns] = useState<DetectedPattern[]>([])
  useEffect(() => {
    if (!open) return
    let cancelled = false
    // Patterns are optional shortcuts beside the generic goals, so a failure
    // just leaves them out; the wizard works without them.
    getList<DetectedPattern>('/api/style-profile/patterns')
      .then((data) => { if (!cancelled) setPatterns(data) })
      .catch(() => { if (!cancelled) setPatterns([]) })
    return () => { cancelled = true }
  }, [open])
  return { patterns, setPatterns }
}
