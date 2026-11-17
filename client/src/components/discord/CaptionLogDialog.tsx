import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import type { CaptionLogCandidates, CaptionLogRow, ParsedCaption } from 'coachboard-shared/discord'

// ---------------------------------------------------------------------------
// L1 (D10, D66): the coach ticked "Also log …" when attaching a video, and the
// day has more than one row the caption could belong to (or none that clearly
// fits). The coach picks the row; a row already logged is shown but cannot be
// picked — nothing is ever overwritten.
// ---------------------------------------------------------------------------

/** "180 kg × 3 @8" — the caption's numbers. */
export function captionResult(p: ParsedCaption): string {
  const parts: string[] = []
  if (p.weightKg != null) parts.push(`${p.weightKg} kg`)
  if (p.reps != null) parts.push(`× ${p.reps}`)
  if (p.rpe != null) parts.push(`@${p.rpe}`)
  return parts.join(' ')
}

/** What the row asks for: "3 × 5 · 180 kg · RPE 8". */
function planned(r: CaptionLogRow): string {
  return [
    r.sets && r.reps ? `${r.sets} × ${r.reps}` : r.reps ? `${r.reps} reps` : r.sets ? `${r.sets} sets` : '',
    r.weight != null ? `${r.weight} kg` : '',
    r.intensity ?? '',
  ].filter(Boolean).join(' · ')
}

/** The caption's reps when they are not what the row planned. */
export function repsDiffer(r: CaptionLogRow, p: ParsedCaption): boolean {
  return p.reps != null && (r.reps ?? '').trim() !== String(p.reps)
}

export default function CaptionLogDialog({
  data,
  onClose,
  onPick,
}: {
  data: CaptionLogCandidates | null
  onClose: () => void
  onPick: (row: CaptionLogRow) => void
}) {
  const [showAll, setShowAll] = useState(false)
  const fitting = data?.rows.filter((r) => r.fits) ?? []
  const rows = !data ? [] : showAll || fitting.length === 0 ? data.rows : fitting
  const hidden = data ? data.rows.length - rows.length : 0

  return (
    <Dialog open={!!data} onOpenChange={(v) => { if (!v) { setShowAll(false); onClose() } }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Log the result on which row?</DialogTitle>
        </DialogHeader>
        {data && (
          <>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{captionResult(data.caption)}</span> from the caption.
              {fitting.length === 0 && ' No row of the day clearly matches it.'}
            </p>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">This day has no exercises to log it on.</p>
            ) : (
              <div className="max-h-[50vh] space-y-1 overflow-y-auto pr-1">
                {rows.map((r) => (
                  <button
                    key={r.exerciseId}
                    type="button"
                    disabled={r.alreadyLogged}
                    onClick={() => { setShowAll(false); onPick(r) }}
                    className="flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left text-sm hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                  >
                    <span className="font-medium">{r.name}</span>
                    {planned(r) && <span className="text-xs text-muted-foreground">{planned(r)}</span>}
                    {r.alreadyLogged ? (
                      <span className="text-xs text-muted-foreground">
                        Already logged: {[r.loadUsed, r.rpe && `@${r.rpe}`].filter(Boolean).join(' ')}
                      </span>
                    ) : repsDiffer(r, data.caption) && (
                      <span className="text-xs text-muted-foreground">
                        {data.caption.reps} reps will be noted as done{r.reps ? ` (planned ${r.reps})` : ''}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-center justify-between gap-2">
              {hidden > 0 ? (
                <button type="button" className="text-xs text-muted-foreground underline" onClick={() => setShowAll(true)}>
                  Show every row of the day
                </button>
              ) : <span />}
              <Button variant="outline" size="sm" onClick={() => { setShowAll(false); onClose() }}>
                Don’t log it
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
