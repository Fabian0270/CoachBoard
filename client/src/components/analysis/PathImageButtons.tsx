import { useState } from 'react'
import { Copy, ImageDown } from 'lucide-react'
import { readRep, type VelocityMetric } from 'coachboard-shared/vbt'
import type { RepMetrics } from 'coachboard-shared/videoAnalysis'
import { Button } from '../ui/button'
import { useToast } from '../ui/toast'
import type { Stroke } from './annotations'
import { buildPathImage } from './pathImage'

// ---------------------------------------------------------------------------
// Copy or save the frame on screen as an image for the athlete (BP24).
// ---------------------------------------------------------------------------

/** Each rep's speed as the set is read, in order: m/s with a scale, px/s without. */
export function repSpeeds(reps: RepMetrics[], metric: VelocityMetric): string[] {
  return [...reps]
    .sort((a, b) => a.startT - b.startT)
    .map((r) => {
      const v = readRep(r, metric)
      return v != null ? `${v.toFixed(2)} m/s` : `${Math.round(r.meanVelocityPxS)} px/s`
    })
}

export default function PathImageButtons({ videoRef, track, reps, metric, strokes, color, title, note, name }: {
  videoRef: React.MutableRefObject<HTMLVideoElement | null>
  track: { t: number; x: number; y: number }[]
  reps: RepMetrics[]
  metric: VelocityMetric
  strokes: Stroke[]
  color: string
  title: string
  note: string | null
  /** What a saved file is called, before " - bar path.png". */
  name: string
}) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const make = async (): Promise<Blob | null> => {
    const video = videoRef.current
    if (!video) return null
    return buildPathImage({ video, track, reps, strokes, color, title, repSpeeds: repSpeeds(reps, metric), note })
  }

  const run = async (what: 'copy' | 'save') => {
    setBusy(true)
    try {
      const blob = await make()
      if (!blob) return
      if (what === 'copy') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
        toast.success('Image copied — paste it into a message to the athlete.')
      } else {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'lift'} - bar path.png`
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
      }
    } catch (err) {
      toast.error(`The image could not be ${what === 'copy' ? 'copied' : 'saved'}. ${err instanceof Error ? err.message : ''}`.trim())
    } finally {
      setBusy(false)
    }
  }

  const tip = 'The frame on screen with the path, and under it the set, each rep’s speed and your note'
  return (
    <span className="flex items-center gap-1">
      <Button size="sm" variant="outline" onClick={() => run('copy')} disabled={busy} title={`Copy image — ${tip}`}>
        <Copy className="h-4 w-4" /> Copy image
      </Button>
      <Button size="sm" variant="outline" onClick={() => run('save')} disabled={busy} title={`Save image — ${tip}`} aria-label="Save image">
        <ImageDown className="h-4 w-4" />
      </Button>
    </span>
  )
}
