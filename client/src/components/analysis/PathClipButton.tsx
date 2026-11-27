import { useEffect, useRef, useState } from 'react'
import { Film, Loader2, X } from 'lucide-react'
import { Button } from '../ui/button'
import { useToast } from '../ui/toast'
import { DISCORD_MAX_BYTES, formatBytes } from '../recorder/recorder.core'
import type { Stroke } from './annotations'

// ---------------------------------------------------------------------------
// "Save clip with path" (BP25): builds the clip, then hands it to the save
// dialog the way every other download in the app does.
// ---------------------------------------------------------------------------

export default function PathClipButton({ source, track, reps, strokes, color, name }: {
  source: string | Blob
  track: { t: number; x: number; y: number }[]
  reps: { startT: number; endT: number }[]
  strokes: Stroke[]
  color: string
  /** What the file is called, before " - bar path.webm". */
  name: string
}) {
  const toast = useToast()
  const [progress, setProgress] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // Leaving the page stops a clip being built for nobody.
  useEffect(() => () => abortRef.current?.abort(), [])

  const build = async () => {
    const controller = new AbortController()
    abortRef.current = controller
    setProgress(0)
    try {
      // Loaded on demand: the encoder is only needed when a clip is saved.
      const { exportPathClip } = await import('./pathClipExport')
      const blob = await exportPathClip({ source, track, reps, strokes, color, signal: controller.signal, onProgress: setProgress })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'lift'} - bar path.webm`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      toast.success(
        blob.size > DISCORD_MAX_BYTES
          ? `Clip ready, ${formatBytes(blob.size)} — too big to send through Discord (10 MB).`
          : `Clip ready, ${formatBytes(blob.size)}.`,
      )
    } catch (err) {
      if (controller.signal.aborted) return
      toast.error(err instanceof Error ? err.message : 'The clip could not be built.')
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setProgress(null)
    }
  }

  if (progress !== null) {
    return (
      <span className="flex items-center gap-1">
        <Button size="sm" variant="outline" disabled>
          <Loader2 className="h-4 w-4 animate-spin" /> Building clip… {Math.round(progress * 100)}%
        </Button>
        <Button size="sm" variant="ghost" onClick={() => abortRef.current?.abort()} title="Stop building the clip" aria-label="Stop building the clip">
          <X className="h-4 w-4" />
        </Button>
      </span>
    )
  }
  return (
    <Button size="sm" variant="outline" onClick={build} title="A video of the tracked stretch with the path, the dot and your marks drawn in">
      <Film className="h-4 w-4" /> Save clip with path
    </Button>
  )
}
