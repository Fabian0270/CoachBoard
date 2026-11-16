import { useEffect, useMemo, useRef, useState } from 'react'
import { EXERCISE_NAMES } from 'coachboard-shared/exercises'
import { type ColDef, type Exercise, type Workout, DAY_LABELS, exerciseValue } from '../../lib/programUtils'
import { buildBlockRows, weekdayCounts, type BlockRow } from '../../lib/blockLayout'
import { failedEditKeyForColumn } from '../../lib/failedEdits'
import { useToast } from '../ui/toast'

// ---------------------------------------------------------------------------
// The block view (1E): one weekday, exercises down the side, every week across
// with its own small columns, every value editable in place. A second view
// beside the calendar; the day editor stays where a session is written (D40).
//
// The keys are the day editor's (K10): Enter moves to the next field and on
// across the weeks, then down to the next exercise; the arrows go up and down;
// Esc leaves the cell with what was typed kept; Ctrl+Z undoes. Typing into a
// week that does not have the exercise creates it there (D41), and a new row
// goes into every week (D42).
// ---------------------------------------------------------------------------

/** Narrower than the day editor: many weeks share the screen. */
const WIDTH: Partial<Record<ColDef['key'], number>> = {
  rest_time: 52, sets: 46, reps: 50, intensity: 92, load_cap: 62, load_used: 62, rpe: 50, notes: 150,
}

const LONG_DAY = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

type Patch = Partial<Pick<Exercise, 'sets' | 'reps' | 'weight' | 'rest_time' | 'intensity' | 'load_used' | 'rpe' | 'notes'>>
type Move = 'next' | 'up' | 'down'

interface BlockViewProps {
  workoutByDate: Map<string, Workout>
  /** The program's calendar, seven days per week, Monday first. */
  dates: string[]
  weekday: number
  onWeekday: (weekday: number) => void
  /** The program's columns, the exercise name excluded. */
  columns: ColDef[]
  today: string
  unsavedKeys: Set<string>
  suggestions: string[]
  /** Save one cell; creates the exercise in that week when it has none. */
  onSaveCell: (row: BlockRow, rows: BlockRow[], week: number, patch: Patch) => Promise<boolean>
  /** A new exercise on this weekday in every week. */
  onAddRow: (name: string) => Promise<boolean>
  onOpenDay: (date: string) => void
  /** Set by the view: puts the cursor back where it was (the page's arrow keys use it). */
  focusApi: React.MutableRefObject<(() => void) | null>
}

const shortDate = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })

export default function BlockView({
  workoutByDate, dates, weekday, onWeekday, columns, today, unsavedKeys, suggestions,
  onSaveCell, onAddRow, onOpenDay, focusApi,
}: BlockViewProps) {
  const weeks = Math.floor(dates.length / 7)
  const rows = useMemo(() => buildBlockRows(workoutByDate, dates, weekday), [workoutByDate, dates, weekday])
  const counts = useMemo(() => weekdayCounts(workoutByDate, dates), [workoutByDate, dates])
  const gridRef = useRef<HTMLDivElement>(null)
  const last = useRef<string | null>(null)
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(false)
  /** The row a new name will become, focused once it is drawn. */
  const focusRowKey = useRef<string | null>(null)

  const cellEl = (id: string) => gridRef.current?.querySelector<HTMLInputElement>(`[data-bcell="${id}"]`) ?? null
  const focus = (id: string) => {
    const el = cellEl(id)
    if (!el) return
    el.focus()
    el.select()
  }
  focusApi.current = () => focus(last.current && cellEl(last.current) ? last.current : rows.length ? '0:0:0' : 'new')

  useEffect(() => {
    const key = focusRowKey.current
    if (!key) return
    const r = rows.findIndex((row) => row.key === key)
    if (r !== -1) { focusRowKey.current = null; focus(`${r}:0:0`) }
  })

  const move = (r: number, w: number, c: number, dir: Move) => {
    const n = columns.length
    if (dir === 'up') { if (r > 0) focus(`${r - 1}:${w}:${c}`); return }
    if (dir === 'down') { focus(r + 1 < rows.length ? `${r + 1}:${w}:${c}` : 'new'); return }
    if (c + 1 < n) focus(`${r}:${w}:${c + 1}`)
    else if (w + 1 < weeks) focus(`${r}:${w + 1}:0`)
    else focus(r + 1 < rows.length ? `${r + 1}:0:0` : 'new')
  }

  const addRow = async () => {
    const name = newName.trim()
    if (!name || adding) return
    const lower = name.toLowerCase()
    focusRowKey.current = `${lower}#${rows.filter((row) => row.name.toLowerCase() === lower).length}`
    setAdding(true)
    const ok = await onAddRow(name)
    setAdding(false)
    if (ok) setNewName('')
    else focusRowKey.current = null
  }

  const dayName = LONG_DAY[weekday]

  return (
    <div className="space-y-3">
      <div role="group" aria-label="Training day" className="flex flex-wrap items-center gap-1">
        {DAY_LABELS.map((label, i) => (
          <button
            key={label}
            type="button"
            aria-pressed={i === weekday}
            onClick={() => onWeekday(i)}
            title={counts[i] ? `${LONG_DAY[i]}: ${counts[i]} week${counts[i] === 1 ? '' : 's'} with training` : `No training on ${LONG_DAY[i]}s yet`}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring/40 ${
              i === weekday
                ? 'border-primary bg-primary text-primary-foreground'
                : counts[i] ? 'hover:border-foreground/25' : 'text-muted-foreground/60 hover:text-foreground'
            }`}
          >
            {label}
            {counts[i] > 0 && <span className={`num ml-1 ${i === weekday ? 'opacity-80' : 'text-muted-foreground'}`}>{counts[i]}</span>}
          </button>
        ))}
      </div>

      <div ref={gridRef} className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="border-collapse text-sm" aria-label={`${dayName}s, week by week`}>
          <thead>
            <tr>
              <th rowSpan={2} className="sticky left-0 z-10 min-w-[180px] border-b border-r border-border bg-card px-2.5 py-2 text-left text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Exercise
              </th>
              {Array.from({ length: weeks }, (_, w) => {
                const date = dates[w * 7 + weekday]
                const week = dates.slice(w * 7, w * 7 + 7)
                const thisWeek = week.includes(today)
                return (
                  <th key={w} colSpan={columns.length} className={`border-b border-l-2 border-border p-0 text-left ${thisWeek ? 'bg-primary/[0.06]' : ''}`}>
                    <button
                      type="button"
                      onClick={() => onOpenDay(date)}
                      title={`Open ${dayName} ${shortDate(date)} in the day editor`}
                      className="w-full px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.05] hover:text-foreground focus:outline-none focus:ring-1 focus:ring-inset focus:ring-primary"
                    >
                      <span className="text-foreground">Week {w + 1}</span>
                      <span className="num ml-1.5">{shortDate(date)}</span>
                      {thisWeek && <span className="ml-1.5 text-primary">this week</span>}
                    </button>
                  </th>
                )
              })}
            </tr>
            <tr>
              {Array.from({ length: weeks }, (_, w) => columns.map((c, ci) => (
                <th
                  key={`${w}:${c.key}`}
                  style={{ minWidth: WIDTH[c.key] ?? 60 }}
                  className={`border-b border-border px-1.5 py-1 text-left text-[10px] font-medium text-muted-foreground ${ci === 0 ? 'border-l-2' : 'border-l'}`}
                >
                  {c.label}
                </th>
              )))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={row.key}>
                <th scope="row" className="sticky left-0 z-10 max-w-[240px] border-b border-r border-border bg-card px-2.5 py-1 text-left text-[13px] font-medium" title={row.name}>
                  {row.isSet
                    ? <span className="pl-3 text-muted-foreground" aria-label={`${row.name}, next set`}>↳</span>
                    : <span className="block truncate">{row.name || '—'}</span>}
                </th>
                {row.cells.map((ex, w) => columns.map((c, ci) => (
                  <td key={`${w}:${c.key}`} className={`border-b border-border p-0 ${ci === 0 ? 'border-l-2' : 'border-l'} ${ex ? '' : 'bg-muted/30'}`}>
                    <BlockCell
                      id={`${r}:${w}:${ci}`}
                      // Keyed by place, not by exercise: a cell that creates its
                      // exercise keeps the cursor when the exercise appears.
                      key={`${row.key}:${w}:${c.key}`}
                      col={c}
                      value={ex ? exerciseValue(ex, c.key) : ''}
                      label={`${row.name || 'Exercise'}${row.isSet ? ' (next set)' : ''}, week ${w + 1}, ${c.label}`}
                      missing={!ex}
                      unsaved={!!ex && unsavedKeys.has(failedEditKeyForColumn(ex.id, c.key))}
                      onFocus={() => { last.current = `${r}:${w}:${ci}` }}
                      onCommit={(patch) => onSaveCell(row, rows, w, patch)}
                      onMove={(dir) => move(r, w, ci, dir)}
                    />
                  </td>
                )))}
              </tr>
            ))}
            <tr>
              <th scope="row" className="sticky left-0 z-10 border-r border-border bg-card p-0 text-left font-normal">
                <input
                  data-bcell="new"
                  list="block-exercise-names"
                  value={newName}
                  disabled={adding}
                  onChange={(e) => setNewName(e.target.value)}
                  onFocus={() => { last.current = 'new' }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); void addRow() }
                    else if (e.key === 'ArrowUp' && rows.length) { e.preventDefault(); focus(`${rows.length - 1}:0:0`) }
                    else if (e.key === 'Escape') { setNewName(''); e.currentTarget.blur() }
                  }}
                  aria-label={`New exercise in every ${dayName}`}
                  placeholder={`+ Add to every ${dayName}`}
                  className="w-full min-w-[180px] bg-transparent px-2.5 py-1.5 text-[13px] outline-none placeholder:text-muted-foreground/60 focus:bg-accent/30 focus:ring-1 focus:ring-inset focus:ring-primary"
                />
              </th>
              <td colSpan={weeks * columns.length} className="px-2 text-[11px] text-muted-foreground">
                {rows.length === 0
                  ? `Nothing on ${dayName}s yet. Name an exercise to put it in every week.`
                  : 'Enter moves across the weeks · ↑↓ change exercise · an empty cell creates the exercise in that week'}
              </td>
            </tr>
          </tbody>
        </table>
        <datalist id="block-exercise-names">
          {[...new Set([...suggestions, ...EXERCISE_NAMES])].map((n) => <option key={n} value={n} />)}
        </datalist>
      </div>
    </div>
  )
}

/**
 * One value. What is typed stays until the save is answered and is never
 * overwritten from the program in the meantime (the day editor's rule, see
 * ExerciseRow): a save landing while the coach types elsewhere must not put a
 * cell back.
 */
function BlockCell({ id, col, value, label, missing, unsaved, onFocus, onCommit, onMove }: {
  id: string
  col: ColDef
  value: string
  label: string
  missing: boolean
  unsaved: boolean
  onFocus: () => void
  onCommit: (patch: Patch) => Promise<boolean>
  onMove: (dir: Move) => void
}) {
  const toast = useToast()
  const [draft, setDraft] = useState(value)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const valueRef = useRef(value)
  valueRef.current = value
  const dirty = useRef(false)
  const pending = useRef<string | null>(null)
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  // Follow the stored value, unless something typed here is still on its way.
  useEffect(() => {
    if (pending.current !== null && pending.current === value) pending.current = null
    if (!dirty.current && pending.current === null) setDraft(value)
  }, [value])

  const commit = () => {
    const v = draftRef.current
    dirty.current = false
    if (v === valueRef.current) return
    let patch: Patch
    if (col.key === 'load_cap') {
      const text = v.trim().replace(',', '.')
      const num = text === '' ? null : Number(text)
      if (num !== null && (Number.isNaN(num) || num < 0)) {
        setDraft(valueRef.current)
        toast.error(`${col.label} takes a number, so "${v}" was not saved.`)
        return
      }
      patch = { weight: num }
    } else {
      patch = { [col.key]: v.trim() === '' ? null : v } as Patch
    }
    pending.current = v
    void onCommitRef.current(patch).then((ok) => {
      // A failed save keeps what was typed, marked, instead of snapping back.
      if (!ok || pending.current !== v) return
      pending.current = null
      if (!dirty.current) setDraft(valueRef.current)
    })
  }

  // Switching weekday or view with the cursor in a cell saves it on the way out.
  useEffect(() => () => { if (dirty.current) commit() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <input
      data-bcell={id}
      value={draft}
      aria-label={label}
      title={missing ? 'Not in this week yet — typing here adds it' : undefined}
      placeholder={missing ? '+' : undefined}
      onFocus={onFocus}
      onChange={(e) => { dirty.current = true; setDraft(e.target.value) }}
      onBlur={commit}
      onKeyDown={(e) => {
        const plain = !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
        if (!plain) return
        if (e.key === 'Enter') { e.preventDefault(); onMove('next') }
        else if (e.key === 'ArrowUp') { e.preventDefault(); onMove('up') }
        else if (e.key === 'ArrowDown') { e.preventDefault(); onMove('down') }
        else if (e.key === 'Escape') { e.currentTarget.blur() }
      }}
      className={`num w-full bg-transparent px-1.5 py-1 text-[12.5px] outline-none placeholder:text-muted-foreground/30 focus:bg-accent/30 focus:ring-1 focus:ring-inset focus:ring-primary ${
        unsaved ? 'bg-destructive/10 ring-1 ring-inset ring-destructive' : ''
      }`}
    />
  )
}
