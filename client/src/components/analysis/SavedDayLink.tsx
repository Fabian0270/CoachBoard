import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarDays, Loader2 } from 'lucide-react'
import { Button } from '../ui/button'
import { useToast } from '../ui/toast'
import { errorMessage, sendJson } from '../../lib/api'
import { localDay } from 'coachboard-shared/vbtSession'
import TrainingDayLink, { NO_LINK, shortDay, type DayLink } from './TrainingDayLink'
import type { VideoAnalysisDto } from 'coachboard-shared/videoAnalysis'

// ---------------------------------------------------------------------------
// The saved page's line for L2: which training day and row this set was, with
// a way to link it, change it or take it off (D70: anything the upgrade could
// not link clearly is linked from here).
// ---------------------------------------------------------------------------

export default function SavedDayLink({
  analysis,
  onSaved,
}: {
  analysis: VideoAnalysisDto
  onSaved: (updated: VideoAnalysisDto) => void
}) {
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [choice, setChoice] = useState<DayLink | null>(null)
  const [resolved, setResolved] = useState<DayLink>(NO_LINK)
  const [saving, setSaving] = useState(false)
  const link = analysis.link

  if (!analysis.athleteId) return null

  const store = async (next: DayLink) => {
    setSaving(true)
    try {
      onSaved(await sendJson<VideoAnalysisDto>('PATCH', `/api/analysis/${analysis.id}`, {
        workoutId: next.workoutId,
        exerciseId: next.workoutId ? next.exerciseId : null,
      }))
      setEditing(false)
      toast.success(next.workoutId ? 'Linked to the training day' : 'No longer linked to a training day')
    } catch (err) {
      toast.error(`Could not change the link. ${errorMessage(err)}`)
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border p-2">
        <TrainingDayLink
          athleteId={analysis.athleteId}
          day={localDay(analysis.liftedAt)}
          lift={analysis.lift}
          loadKg={analysis.loadKg}
          preferredWorkoutId={link?.workoutId ?? null}
          choice={choice}
          onChoose={setChoice}
          onResolved={setResolved}
        />
        <Button size="sm" onClick={() => void store(resolved)} disabled={saving || !resolved.workoutId}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save link
        </Button>
        {link && (
          <Button size="sm" variant="outline" onClick={() => void store(NO_LINK)} disabled={saving}>Unlink</Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
      </div>
    )
  }

  const open = () => {
    // Opens on the current link, row and all; the pickers show the rest.
    setChoice(link ? { workoutId: link.workoutId, exerciseId: link.exerciseId } : null)
    setEditing(true)
  }

  return (
    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <CalendarDays className="h-3.5 w-3.5" />
      {link ? (
        <>
          <Link to={`/programs/${link.programId}`} className="text-foreground underline-offset-2 hover:underline">
            {shortDay(link.date)} · {link.workoutName}{link.exerciseName ? ` — ${link.exerciseName}` : ''}
          </Link>
          <span>· {link.programName}</span>
        </>
      ) : (
        <span>Not linked to a training day.</span>
      )}
      <button type="button" className="underline" onClick={open}>{link ? 'Change' : 'Link…'}</button>
    </p>
  )
}
