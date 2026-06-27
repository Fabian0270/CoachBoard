import type { ExternalColumnMapping } from 'coachboard-shared'
import { colLetter } from './helpers'

export default function ColumnMapping({ mapping }: { mapping: ExternalColumnMapping }) {
  const parts: string[] = []
  if (mapping.exercise) parts.push(`Exercise → ${colLetter(mapping.exercise)}`)
  if (mapping.sets) parts.push(`Sets → ${colLetter(mapping.sets)}`)
  if (mapping.reps) parts.push(`Reps → ${colLetter(mapping.reps)}`)
  if (mapping.load) parts.push(`Load → ${colLetter(mapping.load)}`)
  if (mapping.rpe) parts.push(`${mapping.rpeFromRir ? 'RIR' : 'RPE'} → ${colLetter(mapping.rpe)}`)
  return (
    <div className="text-sm">
      <span className="font-semibold">Detected columns: </span>
      <span className="text-muted-foreground">{parts.join(' · ')}</span>
      {mapping.rpeFromRir && <span className="text-muted-foreground"> (RIR converted to RPE)</span>}
    </div>
  )
}
