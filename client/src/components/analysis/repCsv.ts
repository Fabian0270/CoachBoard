import { repDrift, repTempos, type RepMetrics, type Sample } from 'coachboard-shared/videoAnalysis'

// ---------------------------------------------------------------------------
// A set's rep table as CSV (BP42), for coaches who keep their own sheets.
// The same figures as the table on screen, in plain units, one rep a row.
// ---------------------------------------------------------------------------

const cell = (v: string | number | null | undefined): string => {
  if (v == null) return ''
  const s = String(v)
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const fixed = (n: number | null | undefined, digits: number) => (n == null || !Number.isFinite(n) ? null : n.toFixed(digits))

export function repCsv(reps: RepMetrics[], opts: { track?: Sample[] | null; pixelsPerMetre: number | null; excluded?: Set<number> }): string {
  const { track, pixelsPerMetre, excluded } = opts
  const sorted = [...reps].sort((a, b) => a.startT - b.startT)
  const tempos = track && track.length > 2 ? repTempos(track, sorted) : null
  const metric = pixelsPerMetre != null && pixelsPerMetre > 0
  const unit = metric ? 'm/s' : 'px/s'
  const dist = metric ? 'cm' : 'px'
  const header = [
    'rep', `mean ${unit}`, 'propulsive m/s', `peak ${unit}`, `range ${dist}`,
    `sideways max ${dist}`, `sideways at top ${dist}`, 'down s', 'pause s', 'up s', 'counted',
  ]
  const rows = sorted.map((r, i) => {
    const drift = track ? repDrift(track, r, pixelsPerMetre) : null
    const len = (px: number | undefined, m: number | null | undefined) => (m != null ? fixed(m * 100, 1) : fixed(px, 0))
    return [
      i + 1,
      metric ? fixed(r.meanVelocity, 3) : fixed(r.meanVelocityPxS, 0),
      fixed(r.meanPropulsiveVelocity, 3),
      metric ? fixed(r.peakVelocity, 3) : fixed(r.peakVelocityPxS, 0),
      len(r.romPx, r.romM),
      drift ? len(drift.maxPx, drift.maxM) : null,
      drift ? len(drift.netPx, drift.netM) : null,
      tempos?.[i] ? fixed(tempos[i]!.descentMs / 1000, 2) : null,
      tempos?.[i] ? fixed(tempos[i]!.pauseMs / 1000, 2) : null,
      fixed(r.durationMs / 1000, 2),
      excluded?.has(r.index) ? 'no' : 'yes',
    ]
  })
  return [header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n'
}

/** Hands the CSV to the save dialog, like every other download in the app. */
export function downloadCsv(csv: string, name: string) {
  // A byte-order mark so Excel reads the file as UTF-8.
  const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'lift'} - reps.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
