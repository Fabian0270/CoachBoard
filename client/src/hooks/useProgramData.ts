import { useEffect, useState } from 'react'
import type { Program } from '../lib/programUtils'

export function useProgramData(id: string | undefined): {
  program: Program | null
  setProgram: React.Dispatch<React.SetStateAction<Program | null>>
  notFound: boolean
} {
  const [program, setProgram] = useState<Program | null>(null)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setNotFound(false)
    fetch(`/api/programs/${id}`)
      .then(async (r) => {
        if (!r.ok) {
          if (!cancelled) setNotFound(true)
          return
        }
        const data = await r.json()
        if (!cancelled) setProgram(data)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [id])

  return { program, setProgram, notFound }
}
