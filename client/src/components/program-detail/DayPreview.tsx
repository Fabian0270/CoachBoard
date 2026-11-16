import { createPortal } from 'react-dom'
import type { Workout } from '../../lib/programUtils'

/**
 * The whole day, shown when the pointer rests on a calendar cell.
 *
 * Cells stop after three exercises ("+4 more"), so reading a long day used to
 * mean opening it. Rendered into <body> with a fixed position: the calendar
 * scrolls sideways inside its own box, which would clip anything drawn in it.
 * It never takes the pointer, so it cannot get in the way of a click or a drag.
 */
export default function DayPreview({
  workout,
  title,
  anchor,
}: {
  workout: Workout
  title: string
  /** The cell's position on screen. */
  anchor: DOMRect
}) {
  const WIDTH = 300
  const gap = 8
  // Beside the cell, on whichever side has room; never off the bottom.
  const left = anchor.right + gap + WIDTH <= window.innerWidth
    ? anchor.right + gap
    : Math.max(8, anchor.left - gap - WIDTH)
  const top = Math.max(8, Math.min(anchor.top, window.innerHeight - 40 - workout.exercises.length * 22))

  return createPortal(
    <div
      role="tooltip"
      style={{ position: 'fixed', left, top, width: WIDTH }}
      className="pointer-events-none z-40 animate-fade-in rounded-lg border bg-popover p-3 text-xs shadow-xl shadow-black/20 motion-reduce:animate-none"
    >
      <div className="mb-1.5 font-semibold text-foreground">{title}</div>
      <table className="w-full border-collapse">
        <tbody>
          {workout.exercises.map((ex, i) => {
            const prev = workout.exercises[i - 1]
            // Further set rows of an exercise show without its name, as in the editor.
            const isSet = !!(ex.group_id && prev?.group_id === ex.group_id)
            const logged = [ex.load_used && `${ex.load_used}`, ex.rpe && `RPE ${ex.rpe}`].filter(Boolean).join(' · ')
            return (
              <tr key={ex.id} className="align-top">
                <td className="py-0.5 pr-2 font-medium text-foreground">
                  {isSet ? <span className="pl-2 text-muted-foreground">↳</span> : ex.name || '—'}
                </td>
                <td className="num whitespace-nowrap py-0.5 pr-2 text-muted-foreground">
                  {ex.sets ?? '–'}×{ex.reps ?? '–'}
                  {ex.weight != null ? ` @${ex.weight}` : ''}
                </td>
                <td className="py-0.5 text-muted-foreground">{ex.intensity ?? ''}</td>
                {ex.notes && <td className="py-0.5 pl-2 italic text-muted-foreground">{ex.notes}</td>}
                {logged && <td className="num whitespace-nowrap py-0.5 pl-2 text-success">{logged}</td>}
              </tr>
            )
          })}
        </tbody>
      </table>
      {workout.notes && <p className="mt-2 whitespace-pre-wrap text-muted-foreground">{workout.notes}</p>}
    </div>,
    document.body,
  )
}
