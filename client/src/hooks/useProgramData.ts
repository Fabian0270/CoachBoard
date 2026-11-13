import { useCallback, useEffect, useRef, useState } from 'react'
import type { Program } from '../lib/programUtils'
import { ApiError, errorMessage, getJson } from '../lib/api'

/**
 * Loads one program.
 *
 * Used to treat every non-2xx as "not found — it may have been deleted", which
 * is a frightening thing to tell a coach about a 500, and to swallow a network
 * failure entirely, leaving the page on "Loading..." forever. Only a 404 means
 * the program is gone; anything else is a load error the page can retry.
 */
export function useProgramData(id: string | undefined): {
  program: Program | null
  setProgram: React.Dispatch<React.SetStateAction<Program | null>>
  notFound: boolean
  loadError: string | null
  reload: () => void
} {
  const [program, setProgram] = useState<Program | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Bumped to re-run the load; also lets a stale response be ignored.
  const [attempt, setAttempt] = useState(0)
  const latest = useRef(0)

  useEffect(() => {
    if (!id) return
    const run = ++latest.current
    setNotFound(false)
    setLoadError(null)
    getJson<Program>(`/api/programs/${encodeURIComponent(id)}`)
      .then((data) => { if (run === latest.current) setProgram(data) })
      .catch((err) => {
        if (run !== latest.current) return
        if (err instanceof ApiError && err.status === 404) setNotFound(true)
        else setLoadError(errorMessage(err))
      })
    return () => { latest.current++ }
  }, [id, attempt])

  const reload = useCallback(() => setAttempt((n) => n + 1), [])

  return { program, setProgram, notFound, loadError, reload }
}
