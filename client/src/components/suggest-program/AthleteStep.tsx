import type { SelectableAthlete } from './types'

interface AthleteStepProps {
  sourcesLoading: boolean
  sourcesError: string | null
  sourceAthletes: SelectableAthlete[] | null
  onPick: (athleteId: string) => void
}

export default function AthleteStep({ sourcesLoading, sourcesError, sourceAthletes, onPick }: AthleteStepProps) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground mb-3">Select the athlete to generate a program for:</p>
      {sourcesLoading && <p className="text-sm text-muted-foreground">Loading athletes…</p>}
      {sourcesError && <p className="text-sm text-destructive">{sourcesError}</p>}
      {sourceAthletes !== null && sourceAthletes.length === 0 && (
        <p className="text-sm text-muted-foreground">No athletes found.</p>
      )}
      {sourceAthletes?.map((a) => (
        <button
          key={a.id}
          onClick={() => onPick(a.id)}
          className="w-full text-left rounded-lg border p-3 hover:bg-accent transition-colors font-medium"
        >
          {a.name}
        </button>
      ))}
    </div>
  )
}
