import type { SelectableAthlete, SelectableProgram } from './types'
import BackButton from './BackButton'

interface SourceStepProps {
  pickingSourceAthlete: boolean
  sourcesLoading: boolean
  sourcesError: string | null
  sourceAthletes: SelectableAthlete[] | null
  sourcePrograms: SelectableProgram[] | null
  targetAthleteId: string | null
  viewingOtherAthlete: boolean
  sourceAthleteName: string | null
  showBack: boolean
  onPickSourceAthlete: (athleteId: string) => void
  onStopPickingSourceAthlete: () => void
  onStartPickingSourceAthlete: () => void
  onResetToOwnAthlete: () => void
  onPickSourceProgram: (prog: SelectableProgram) => void
  onBack: () => void
}

export default function SourceStep({
  pickingSourceAthlete, sourcesLoading, sourcesError, sourceAthletes, sourcePrograms,
  targetAthleteId, viewingOtherAthlete, sourceAthleteName, showBack,
  onPickSourceAthlete, onStopPickingSourceAthlete, onStartPickingSourceAthlete,
  onResetToOwnAthlete, onPickSourceProgram, onBack,
}: SourceStepProps) {
  if (pickingSourceAthlete) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground mb-3">Whose program should the new block be based on?</p>
        {sourcesLoading && <p className="text-sm text-muted-foreground">Loading athletes…</p>}
        {sourcesError && <p className="text-sm text-destructive">{sourcesError}</p>}
        {sourceAthletes !== null && sourceAthletes.length === 0 && (
          <p className="text-sm text-muted-foreground">No athletes found.</p>
        )}
        {sourceAthletes?.map((a) => (
          <button
            key={a.id}
            onClick={() => onPickSourceAthlete(a.id)}
            className="w-full text-left rounded-lg border p-3 hover:bg-accent transition-colors font-medium flex items-center justify-between gap-2"
          >
            <span>{a.name}</span>
            {a.id === targetAthleteId && (
              <span className="text-xs font-normal rounded bg-muted px-1.5 py-0.5 text-muted-foreground">this athlete</span>
            )}
          </button>
        ))}
        <BackButton onClick={onStopPickingSourceAthlete} />
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground mb-3">Which completed or archived program should the new block be based on?</p>
      {viewingOtherAthlete && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          <span className="text-muted-foreground">
            Showing <span className="font-medium text-foreground">{sourceAthleteName ?? 'another athlete'}</span>'s programs
          </span>
          <button type="button" onClick={onResetToOwnAthlete} className="text-xs text-muted-foreground underline shrink-0">
            Show this athlete's
          </button>
        </div>
      )}
      {sourcesLoading && <p className="text-sm text-muted-foreground">Loading programs…</p>}
      {sourcesError && <p className="text-sm text-destructive">{sourcesError}</p>}
      {sourcePrograms !== null && sourcePrograms.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No completed or archived programs found for this athlete{viewingOtherAthlete ? '' : ' yet'}.
        </p>
      )}
      {sourcePrograms?.map((p) => (
        <button
          key={p.id}
          onClick={() => onPickSourceProgram(p)}
          className="w-full text-left rounded-lg border p-3 hover:bg-accent transition-colors"
        >
          <div className="font-medium flex items-center justify-between gap-2">
            <span>{p.name}</span>
            {p.status === 'archived' && (
              <span className="text-xs font-normal rounded bg-muted px-1.5 py-0.5 text-muted-foreground">archived</span>
            )}
          </div>
          {p.start_date && (
            <div className="text-xs text-muted-foreground mt-0.5">Started: {p.start_date}</div>
          )}
        </button>
      ))}
      {/* Always available: base the block on any other athlete's program. */}
      <button
        type="button"
        onClick={onStartPickingSourceAthlete}
        className="w-full text-left rounded-lg border border-dashed p-3 hover:bg-accent transition-colors text-sm text-muted-foreground"
      >
        Use another athlete's program…
      </button>
      {showBack && <BackButton onClick={onBack} />}
    </div>
  )
}
