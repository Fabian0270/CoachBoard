import { useEffect, useState } from 'react'
import type { DetectedPattern } from 'coachboard-shared'

// Detected periodization patterns (Feature 5d) — fetched once per open, shown
// as named shortcuts on the goal step alongside the generic goals.
export function usePatterns(open: boolean) {
  const [patterns, setPatterns] = useState<DetectedPattern[]>([])
  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetch('/api/style-profile/patterns')
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setPatterns(Array.isArray(data) ? data : []) })
      .catch(() => { if (!cancelled) setPatterns([]) })
    return () => { cancelled = true }
  }, [open])
  return { patterns, setPatterns }
}
