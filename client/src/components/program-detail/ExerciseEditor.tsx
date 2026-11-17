import { Fragment, useEffect, useRef, useState } from 'react'
import { Button } from '../ui/button'
import { Plus, Trash2, Copy } from 'lucide-react'
import {
  type Workout,
  type Exercise,
  type ToggleableColumn,
  type ColKey,
  type ColDef,
  DEFAULT_COL_WIDTH,
  buildColumns,
} from '../../lib/programUtils'
import ExerciseRow, { type RowKeyAction } from './ExerciseRow'
import { dayLoadHints, type StoredMax } from '../../lib/loadHint'
import { isCellBlock } from '../../lib/pasteGrid'

interface ExerciseEditorProps {
  workout: Workout | null
  enabledColumns: ToggleableColumn[]
  programId: string
  /** Every day of the program, as somewhere this day could be copied to. */
  copyGrid: CopyWeek[]
  /** `${exerciseId}:${field}` for every edit that has not been stored yet. */
  unsavedKeys?: Set<string>
  onAdd: () => Promise<void>
  /** Copy the exercise (with its set rows) directly under itself. */
  onDuplicate: (exerciseId: string) => void
  /** The same weekday one week earlier, to show what was done there. */
  previous?: Workout | null
  /** The athlete's stored maxes, for suggested loads. Empty: no suggestions. */
  maxes?: StoredMax[]
  /** Save the coach's note for the day. Resolves false when it did not save. */
  onSaveNote: (notes: string) => Promise<boolean>
  /**
   * Cells pasted from a spreadsheet: into the row `anchorId` from column
   * `start` and down into new rows, or at the end of the day when no row had
   * the cursor.
   */
  onPasteRows?: (anchorId: string | null, start: ColKey, text: string) => void
  /** The coach's own exercise names, most used first. Offered before the built-in list. */
  suggestions?: readonly string[]
  onSaveField: (exerciseId: string, patch: Partial<Exercise>) => Promise<boolean>
  onDeleteExercise: (exerciseId: string) => Promise<boolean>
  onDeleteWorkout: () => void
  onAddSet: (exerciseId: string) => void
  /** Resolves false when the copy did not happen; the dialog then stays open. */
  onCopyDay: (targetDates: string[]) => Promise<boolean>
  onReorder: (exerciseIds: string[]) => void
}

function useColumnWidths(programId: string, columns: ColDef[]): [Record<string, number>, (key: ColKey, width: number) => void] {
  const storageKey = `program-col-widths:${programId}`
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    const defaults: Record<string, number> = {}
    columns.forEach((c) => { defaults[c.key] = DEFAULT_COL_WIDTH[c.key] })
    if (!programId) return defaults
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
      return { ...defaults, ...stored }
    } catch { return defaults }
  })
  const setWidth = (key: ColKey, width: number) => {
    setWidths((prev) => {
      const next = { ...prev, [key]: width }
      if (programId) {
        try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* ignore */ }
      }
      return next
    })
  }
  return [widths, setWidth]
}

// Group consecutive exercises that share the same group_id
function buildGroups(exercises: Exercise[]) {
  type Group = { groupId: string | null; exercises: Exercise[] }
  const groups: Group[] = []
  for (const ex of exercises) {
    const gid = ex.group_id ?? null
    const last = groups[groups.length - 1]
    if (gid && last && last.groupId === gid) {
      last.exercises.push(ex)
    } else {
      groups.push({ groupId: gid, exercises: [ex] })
    }
  }
  return groups
}

export interface CopyDay {
  date: string
  /** "Mon" */
  weekday: string
  isSource: boolean
  sameWeekday: boolean
  /** Already has exercises, which a copy would replace. */
  occupied: boolean
  /** Holds Load Used / RPE from the athlete, which a copy would erase. */
  hasResults: boolean
}
export interface CopyWeek { weekIndex: number; days: CopyDay[] }

export default function ExerciseEditor({ workout, enabledColumns, programId, copyGrid, unsavedKeys, onAdd, onDuplicate, previous, maxes = NO_MAXES, onSaveNote, onPasteRows, suggestions, onSaveField, onDeleteExercise, onDeleteWorkout, onAddSet, onCopyDay, onReorder }: ExerciseEditorProps) {
  const exercises = workout?.exercises ?? []
  const columns = buildColumns(enabledColumns)
  const [widths, setWidth] = useColumnWidths(programId, columns)
  const activeResizeCleanup = useRef<(() => void) | null>(null)
  const [copyOpen, setCopyOpen] = useState(false)
  // Opening the panel hides its own button, which dropped the cursor onto the
  // dialog itself. It goes into the panel instead, and back to the button when
  // the panel closes.
  const copyButtonRef = useRef<HTMLButtonElement>(null)
  const copyPanelRef = useRef<HTMLDivElement>(null)
  const copyWasOpen = useRef(false)
  useEffect(() => {
    if (copyOpen) copyPanelRef.current?.querySelector<HTMLElement>('button, input:not(:disabled)')?.focus()
    else if (copyWasOpen.current) copyButtonRef.current?.focus()
    copyWasOpen.current = copyOpen
  }, [copyOpen])
  const [selectedDates, setSelectedDates] = useState<Set<string>>(new Set())
  const [copying, setCopying] = useState(false)

  // Drag-and-drop state
  type DragInfo = { exerciseId: string; mode: 'group' | 'set'; groupId: string | null }
  const draggingRef = useRef<DragInfo | null>(null)
  const [dragging, setDragging] = useState<DragInfo | null>(null)
  // null = no drag, 'end' = insert after all, string = insert before this exercise ID
  const [dropBeforeId, setDropBeforeId] = useState<string | 'end' | null>(null)
  // Lock the table wrapper height during drag so the dialog doesn't resize as
  // placeholder rows appear/disappear, which would cause twitching.
  const tableWrapperRef = useRef<HTMLDivElement>(null)
  const [dragLockedHeight, setDragLockedHeight] = useState<number | null>(null)
  // The autocomplete menu portals into the dialog content (not document.body),
  // so Radix keeps it interactive and it escapes the table's scroll clipping.
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(null)
  // The cursor starts in the day, not on a header button: first cell if there
  // is one, otherwise "Add exercise".
  useEffect(() => {
    const root = tableWrapperRef.current?.parentElement
    const target = root?.querySelector<HTMLElement>('[data-cell]') ?? root?.querySelector<HTMLElement>('[data-add-exercise]')
    target?.focus()
  }, [])

  useEffect(() => {
    setPortalContainer((tableWrapperRef.current?.closest('[role="dialog"]') as HTMLElement) ?? null)
  }, [])

  const startGroupDrag = (exerciseId: string, groupId: string | null) => (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move'
    const info: DragInfo = { exerciseId, mode: 'group', groupId }
    draggingRef.current = info
    const h = tableWrapperRef.current?.getBoundingClientRect().height
    if (h) setDragLockedHeight(h)
    setDragging(info)
  }

  const startSetDrag = (exerciseId: string, groupId: string) => (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move'
    const info: DragInfo = { exerciseId, mode: 'set', groupId }
    draggingRef.current = info
    const h = tableWrapperRef.current?.getBoundingClientRect().height
    if (h) setDragLockedHeight(h)
    setDragging(info)
  }

  const stopDrag = () => {
    draggingRef.current = null
    setDragging(null)
    setDropBeforeId(null)
    setDragLockedHeight(null)
  }

  // The editor lives inside a Radix <Dialog> portal (rendered to document.body, outside
  // the React root container). React 18 attaches synthetic event listeners to the root
  // container, so onDragEnd on the grip span never fires in a portal. Register a native
  // document listener instead whenever a drag is in progress.
  useEffect(() => {
    if (!dragging) return
    const handler = () => {
      draggingRef.current = null
      setDragging(null)
      setDropBeforeId(null)
      setDragLockedHeight(null)
    }
    document.addEventListener('dragend', handler, { capture: true })
    return () => document.removeEventListener('dragend', handler, { capture: true })
  }, [dragging])

  // Called by onDragOver on each row — determines where the placeholder appears
  const handleDragOverRow = (ex: Exercise, group: ReturnType<typeof buildGroups>[0]) => (e: React.DragEvent) => {
    const info = draggingRef.current
    if (!info) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const isTopHalf = e.clientY < rect.top + rect.height / 2

    if (info.mode === 'group') {
      const dragGroup = groups.find(g => g.exercises.some(x => x.id === info.exerciseId))
      // Hovering own group — no valid drop, clear placeholder, don't prevent default
      if (!dragGroup || dragGroup === group) { setDropBeforeId(null); return }
      e.preventDefault()
      if (isTopHalf) {
        setDropBeforeId(group.exercises[0].id)
      } else {
        const gi = groups.indexOf(group)
        let next: string | 'end' = 'end'
        for (let k = gi + 1; k < groups.length; k++) {
          if (groups[k] !== dragGroup) { next = groups[k].exercises[0].id; break }
        }
        setDropBeforeId(next)
      }
    } else {
      // Hovering own exercise or wrong group — clear placeholder
      if (group.groupId !== info.groupId || ex.id === info.exerciseId) { setDropBeforeId(null); return }
      e.preventDefault()
      if (isTopHalf) {
        setDropBeforeId(ex.id)
      } else {
        const idx = group.exercises.findIndex(x => x.id === ex.id)
        let next: string | 'end' = 'end'
        for (let k = idx + 1; k < group.exercises.length; k++) {
          if (group.exercises[k].id !== info.exerciseId) { next = group.exercises[k].id; break }
        }
        setDropBeforeId(next)
      }
    }
  }

  const executeDrop = () => {
    const info = draggingRef.current
    if (!info || dropBeforeId === null) { stopDrag(); return }

    if (info.mode === 'group') {
      const dragGroup = groups.find(g => g.exercises.some(x => x.id === info.exerciseId))
      if (!dragGroup) { stopDrag(); return }
      const others = groups.filter(g => g !== dragGroup)
      const insertAt = dropBeforeId === 'end'
        ? others.length
        : others.findIndex(g => g.exercises[0].id === dropBeforeId)
      if (insertAt === -1) { stopDrag(); return }
      const newGroups = [...others.slice(0, insertAt), dragGroup, ...others.slice(insertAt)]
      onReorder(newGroups.flatMap(g => g.exercises.map(x => x.id)))
    } else {
      const group = groups.find(g => g.groupId === info.groupId)
      if (!group) { stopDrag(); return }
      const ids = group.exercises.map(x => x.id)
      const otherIds = ids.filter(id => id !== info.exerciseId)
      const insertAt = dropBeforeId === 'end'
        ? otherIds.length
        : otherIds.indexOf(dropBeforeId)
      if (insertAt === -1) { stopDrag(); return }
      const newIds = [...otherIds.slice(0, insertAt), info.exerciseId, ...otherIds.slice(insertAt)]
      const groupSet = new Set(ids)
      let gi = 0
      onReorder(exercises.map(x => groupSet.has(x.id) ? newIds[gi++] : x.id))
    }
    stopDrag()
  }

  useEffect(() => {
    return () => {
      activeResizeCleanup.current?.()
      activeResizeCleanup.current = null
    }
  }, [])

  const startResize = (key: ColKey) => (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = widths[key] ?? DEFAULT_COL_WIDTH[key]
    const onMove = (ev: MouseEvent) => {
      setWidth(key, Math.max(40, startW + (ev.clientX - startX)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      activeResizeCleanup.current = null
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    activeResizeCleanup.current = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }

  // ── Keyboard: where the cursor goes ─────────────────────────────────────
  // Rows only know their own cells. Which cell is "next", and what a row key
  // does to the rows around it, is decided here.
  const exercisesRef = useRef(exercises)
  exercisesRef.current = exercises
  /** A cell to focus once the table has caught up with a change. */
  const pendingFocus = useRef<
    | { kind: 'cell'; id: string; col: string }
    | { kind: 'new'; known: Set<string> }
    | null
  >(null)

  const cellEl = (id: string, col: string) =>
    tableWrapperRef.current?.querySelector<HTMLTextAreaElement | HTMLInputElement>(`[data-cell="${id}:${col}"]`) ?? null
  /** The cells a row actually has: a set row under an exercise has no name. */
  const rowCols = (id: string): string[] =>
    columns.map((c) => c.key as string).filter((key) => cellEl(id, key) !== null)
  const focusCell = (id: string, col: string): boolean => {
    const el = cellEl(id, col) ?? cellEl(id, rowCols(id)[0] ?? '')
    if (!el) return false
    el.focus()
    el.select()
    return true
  }

  // Runs after every render: a pending focus waits for its row to exist.
  useEffect(() => {
    const want = pendingFocus.current
    if (!want) return
    if (want.kind === 'cell') {
      if (focusCell(want.id, want.col)) pendingFocus.current = null
      return
    }
    const fresh = exercises.find((ex) => !want.known.has(ex.id))
    if (fresh && focusCell(fresh.id, 'name')) pendingFocus.current = null
  })

  const knownIds = () => new Set(exercisesRef.current.map((ex) => ex.id))

  const adding = useRef(false)
  /** Add an exercise and put the cursor in it. One at a time: a double click used to make two. */
  const addAndFocus = async () => {
    if (adding.current) return
    adding.current = true
    pendingFocus.current = { kind: 'new', known: knownIds() }
    try {
      await onAdd()
    } finally {
      adding.current = false
    }
  }

  const addSetAndFocus = (exerciseId: string) => {
    pendingFocus.current = { kind: 'new', known: knownIds() }
    onAddSet(exerciseId)
  }

  const handleRowKey = (ex: Exercise, action: RowKeyAction, col: string) => {
    const list = exercisesRef.current
    const i = list.findIndex((x) => x.id === ex.id)
    if (i === -1) return
    switch (action) {
      case 'next': {
        const cols = rowCols(ex.id)
        const at = cols.indexOf(col)
        if (at !== -1 && at < cols.length - 1) { focusCell(ex.id, cols[at + 1]); return }
        const below = list[i + 1]
        if (below) { focusCell(below.id, rowCols(below.id)[0]); return }
        // Last field of the last exercise: save it, then start a new one.
        ;(document.activeElement as HTMLElement | null)?.blur()
        void addAndFocus()
        return
      }
      case 'up':
      case 'down': {
        const other = list[i + (action === 'up' ? -1 : 1)]
        if (other) focusCell(other.id, col)
        return
      }
      case 'left':
      case 'right': {
        // Within the row; Enter is what carries on to the next exercise.
        const cols = rowCols(ex.id)
        const to = cols[cols.indexOf(col) + (action === 'left' ? -1 : 1)]
        if (to) focusCell(ex.id, to)
        return
      }
      case 'add-set':
        addSetAndFocus(ex.id)
        return
      case 'duplicate':
        pendingFocus.current = { kind: 'new', known: knownIds() }
        onDuplicate(ex.id)
        return
      case 'delete': {
        // The row is going: park the cursor on the one that takes its place.
        const other = list[i + 1] ?? list[i - 1]
        pendingFocus.current = other ? { kind: 'cell', id: other.id, col } : null
        if (!other) tableWrapperRef.current?.parentElement?.querySelector<HTMLElement>('[data-add-exercise]')?.focus()
        return
      }
      case 'move-up':
      case 'move-down': {
        const dir = action === 'move-up' ? -1 : 1
        const groupList = buildGroups(list)
        const gi = groupList.findIndex((g) => g.exercises.some((x) => x.id === ex.id))
        const group = groupList[gi]
        const within = group.exercises.findIndex((x) => x.id === ex.id)
        let order: string[]
        if (within > 0) {
          // A set row moves among the sets of its own exercise.
          const to = within + dir
          if (to < 0 || to >= group.exercises.length) return
          const ids = group.exercises.map((x) => x.id)
          ;[ids[within], ids[to]] = [ids[to], ids[within]]
          const inGroup = new Set(ids)
          let k = 0
          order = list.map((x) => (inGroup.has(x.id) ? ids[k++] : x.id))
        } else {
          // The exercise moves as a whole, with all of its sets.
          const to = gi + dir
          if (to < 0 || to >= groupList.length) return
          const moved = [...groupList]
          ;[moved[gi], moved[to]] = [moved[to], moved[gi]]
          order = moved.flatMap((g) => g.exercises.map((x) => x.id))
        }
        // Moving a row in the DOM drops focus; put it back where it was.
        pendingFocus.current = { kind: 'cell', id: ex.id, col }
        onReorder(order)
        return
      }
    }
  }

  const toggleDate = (date: string) => {
    setSelectedDates((prev) => {
      const next = new Set(prev)
      if (next.has(date)) next.delete(date); else next.add(date)
      return next
    })
  }

  const handleCopy = async () => {
    if (selectedDates.size === 0) return
    setCopying(true)
    try {
      // Kept open on failure, with the selection intact, so a retry is one click.
      if (!(await onCopyDay([...selectedDates]))) return
      setCopyOpen(false)
      setSelectedDates(new Set())
    } finally {
      setCopying(false)
    }
  }

  const groups = buildGroups(exercises)

  // The suggested load for each row, top to bottom (a back-off follows the set above).
  const hintFor = dayLoadHints(exercises, maxes)

  // Last week, row by row: the nth row named "Squat" today lines up with the
  // nth row named "Squat" a week earlier, so set rows line up with set rows.
  // Progressing a lift week to week meant opening last week from memory.
  const lastWeekFor = (() => {
    const before = new Map<string, Exercise[]>()
    for (const ex of previous?.exercises ?? []) {
      const key = ex.name.trim().toLowerCase()
      if (!key) continue
      before.set(key, [...(before.get(key) ?? []), ex])
    }
    const seen = new Map<string, number>()
    const out = new Map<string, string>()
    for (const ex of exercises) {
      const key = ex.name.trim().toLowerCase()
      if (!key) continue
      const n = seen.get(key) ?? 0
      seen.set(key, n + 1)
      const match = before.get(key)?.[n]
      if (match) out.set(ex.id, describeLastWeek(match))
    }
    return out
  })()

  // The day's note: kept as typed until it leaves the field, like the cells.
  const [note, setNote] = useState(workout?.notes ?? '')
  const noteSaved = useRef(workout?.notes ?? '')
  useEffect(() => {
    // Follow a note that changed elsewhere (an undo), unless one is being typed.
    if (document.activeElement?.id !== 'day-note' && (workout?.notes ?? '') !== noteSaved.current) {
      noteSaved.current = workout?.notes ?? ''
      setNote(noteSaved.current)
    }
  }, [workout?.notes])
  const saveNote = async () => {
    if (note.trim() === noteSaved.current.trim()) return
    if (await onSaveNote(note)) noteSaved.current = note.trim()
  }
  const noteRef = useRef(note)
  noteRef.current = note
  // Saved on the way out too, like the cells: closing or paging the day while
  // the cursor is in the note must not lose it.
  const saveNoteRef = useRef(onSaveNote)
  saveNoteRef.current = onSaveNote
  useEffect(() => () => {
    if (noteRef.current.trim() !== noteSaved.current.trim()) void saveNoteRef.current(noteRef.current)
  }, [])
  /** Ticked days that would lose what the athlete logged, by name. */
  const tickedWithResults = copyGrid.flatMap((w) =>
    w.days.filter((d) => d.hasResults && selectedDates.has(d.date)).map((d) => `Week ${w.weekIndex + 1} ${d.weekday}`),
  )

  return (
    <div
      className="flex min-h-0 flex-col gap-3"
      // A block pasted with no cell focused (an empty day, or the cursor on
      // "Add exercise") goes to the end of the day, starting at Exercise.
      onPaste={(e) => {
        const target = e.target as HTMLElement
        if (!onPasteRows || target.closest('[data-cell], #day-note, input, textarea')) return
        const text = e.clipboardData.getData('text/plain')
        if (!isCellBlock(text)) return
        e.preventDefault()
        onPasteRows(null, 'name', text)
      }}
    >
      {/* The table is the part that scrolls; the buttons under it stay put. */}
      <div
        ref={tableWrapperRef}
        className="min-h-0 overflow-auto rounded-md border border-border"
        style={dragLockedHeight != null ? { height: dragLockedHeight, overflowY: 'auto' } : undefined}
      >
        <table className="w-full border-collapse text-sm" style={{ tableLayout: 'fixed' }}>
          <colgroup>
            {columns.flatMap((c) => {
              const col = <col key={c.key} style={{ width: widths[c.key] ?? DEFAULT_COL_WIDTH[c.key] }} />
              return c.key === 'sets' ? [col, <col key="add-set-col" style={{ width: 24 }} />] : [col]
            })}
            {/* delete action */}
            <col style={{ width: 28 }} />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-popover">
            <tr className="bg-muted/50 text-xs text-muted-foreground">
              {columns.flatMap((c) => {
                const th = (
                  <th key={c.key} className="relative border-b border-r border-border px-2 py-1.5 text-left font-medium whitespace-nowrap select-none">
                    {c.label}
                    <span
                      onMouseDown={startResize(c.key)}
                      className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-primary/60 active:bg-primary/80"
                      aria-hidden
                    />
                  </th>
                )
                return c.key === 'sets' ? [th, <th key="add-set-col" className="border-b border-r border-border" />] : [th]
              })}
              <th className="border-b border-border px-2 py-1.5"></th>
            </tr>
          </thead>
          <tbody>
            {exercises.length === 0 && (
              <tr>
                <td colSpan={columns.length + 2} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No exercises yet — click "Add exercise" below to start.
                </td>
              </tr>
            )}
            {groups.map((group, gi) => {
              const isOwnDragGroup = dragging?.mode === 'group' && group.exercises.some(ex => ex.id === dragging.exerciseId)

              return (
                <Fragment key={group.groupId ?? group.exercises[0]?.id ?? gi}>
                  {/* Placeholder before this group during group drag */}
                  {dragging?.mode === 'group' && dropBeforeId === group.exercises[0]?.id && (
                    <PlaceholderRow colCount={columns.length + 2} onDrop={executeDrop} />
                  )}

                  {group.exercises.map((ex, i) => {
                    const isDraggedSet = dragging?.mode === 'set' && ex.id === dragging.exerciseId
                    const isValidSetTarget = dragging?.mode === 'set' && group.groupId === dragging.groupId
                    return (
                      <Fragment key={ex.id}>
                        {isValidSetTarget && !isDraggedSet && dropBeforeId === ex.id && (
                          <PlaceholderRow colCount={columns.length + 2} onDrop={executeDrop} />
                        )}
                        <ExerciseRow
                          exercise={ex}
                          columns={columns}
                          isSubSet={i > 0}
                          isInGroup={group.groupId !== null}
                          isDragging={isOwnDragGroup || isDraggedSet}
                          unsavedKeys={unsavedKeys}
                          onSave={(patch) => onSaveField(ex.id, patch)}
                          onDelete={() => onDeleteExercise(ex.id)}
                          onAddSet={i === group.exercises.length - 1 ? () => addSetAndFocus(ex.id) : undefined}
                          onKey={(action, col) => handleRowKey(ex, action, col)}
                          onPasteBlock={onPasteRows ? (col, text) => onPasteRows(ex.id, col as ColKey, text) : undefined}
                          lastWeek={lastWeekFor.get(ex.id)}
                          loadHint={hintFor.get(ex.id) ?? null}
                          suggestions={suggestions}
                          onGroupDragStart={i === 0 ? startGroupDrag(ex.id, group.groupId) : undefined}
                          onSetDragStart={i > 0 && group.groupId ? startSetDrag(ex.id, group.groupId) : undefined}
                          onDragEnd={stopDrag}
                          onDragOverRow={dragging ? handleDragOverRow(ex, group) : undefined}
                          onDropRow={dragging ? executeDrop : undefined}
                          portalContainer={portalContainer}
                        />
                      </Fragment>
                    )
                  })}

                  {/* Placeholder at end of group during set drag */}
                  {dragging?.mode === 'set' && dragging.groupId === group.groupId && dropBeforeId === 'end' && (
                    <PlaceholderRow colCount={columns.length + 2} onDrop={executeDrop} />
                  )}
                </Fragment>
              )
            })}
            {/* Placeholder after all groups during group drag */}
            {dragging?.mode === 'group' && dropBeforeId === 'end' && (
              <PlaceholderRow colCount={columns.length + 2} onDrop={executeDrop} />
            )}
          </tbody>
        </table>
      </div>

      <div className="shrink-0">
        <label htmlFor="day-note" className="sr-only">Note for this day</label>
        <textarea
          id="day-note"
          rows={1}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => void saveNote()}
          placeholder="Note for this day — only you see it; it is not in the exported sheet"
          style={{ fieldSizing: 'content' } as React.CSSProperties}
          className="block w-full resize-none rounded-md border border-dashed border-border bg-transparent px-2.5 py-1.5 text-sm leading-snug outline-none placeholder:text-muted-foreground/60 focus:border-solid focus:ring-1 focus:ring-primary"
        />
      </div>

      {/* Footer: add exercise / clear day / copy to weeks */}
      <div className="flex shrink-0 items-center justify-between">
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => void addAndFocus()} data-add-exercise>
            <Plus className="h-4 w-4 mr-1" />Add exercise
          </Button>
          {copyGrid.some((w) => w.days.some((d) => !d.isSource)) && exercises.length > 0 && !copyOpen && (
            <Button ref={copyButtonRef} type="button" size="sm" variant="outline" onClick={() => setCopyOpen(true)}>
              <Copy className="h-4 w-4 mr-1" />Copy to…
            </Button>
          )}
        </div>
        {workout && (
          <Button type="button" size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={onDeleteWorkout}>
            <Trash2 className="h-4 w-4 mr-1" />Clear day
          </Button>
        )}
      </div>

      {/* Inline copy panel: any day of the program, not only the same weekday. */}
      {copyOpen && (
        <div ref={copyPanelRef} className="shrink-0 space-y-2 rounded-md border border-border bg-muted/30 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">Copy this day to:</p>
            <Button
              type="button" size="sm" variant="outline" className="h-7"
              // Weeks that hold athlete results stay unticked: copying over
              // them is a choice, never a side effect of "all weeks".
              onClick={() => setSelectedDates(new Set(
                copyGrid.flatMap((w) => w.days).filter((d) => d.sameWeekday && !d.isSource && !d.hasResults).map((d) => d.date),
              ))}
            >
              Same day, all weeks
            </Button>
            {selectedDates.size > 0 && (
              <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => setSelectedDates(new Set())}>
                Untick all
              </Button>
            )}
          </div>
          <table className="border-collapse text-xs">
            <thead>
              <tr>
                <th />
                {copyGrid[0]?.days.map((d) => (
                  <th key={d.weekday} className="px-1.5 pb-1 text-center font-medium text-muted-foreground">{d.weekday}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {copyGrid.map((week) => (
                <tr key={week.weekIndex}>
                  <th className="num pr-2 text-left font-medium text-muted-foreground">W{week.weekIndex + 1}</th>
                  {week.days.map((d) => (
                    <td key={d.date} className="px-1.5 py-0.5 text-center">
                      <label
                        className={`inline-flex cursor-pointer items-center gap-0.5 ${d.isSource ? 'cursor-default opacity-40' : ''}`}
                        title={
                          d.isSource ? 'The day being copied'
                            : d.hasResults ? 'Has athlete results — copying over it erases them'
                            : d.occupied ? 'Has exercises — they will be replaced'
                            : undefined
                        }
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-primary"
                          disabled={d.isSource}
                          checked={selectedDates.has(d.date)}
                          onChange={() => toggleDate(d.date)}
                          aria-label={`Week ${week.weekIndex + 1} ${d.weekday}${d.hasResults ? ', has athlete results' : d.occupied ? ', has exercises' : ''}`}
                        />
                        <span
                          aria-hidden
                          className={`h-1.5 w-1.5 rounded-full ${d.hasResults ? 'bg-warning' : d.occupied && !d.isSource ? 'bg-muted-foreground/40' : 'bg-transparent'}`}
                        />
                      </label>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-muted-foreground">
            Ticked days are replaced by this one.{' '}
            <span className="inline-flex items-center gap-1">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warning" />
              has athlete results, so it is left out unless you tick it.
            </span>
          </p>
          {tickedWithResults.length > 0 && (
            <p className="text-xs font-medium text-destructive" role="alert">
              {tickedWithResults.join(', ')} {tickedWithResults.length === 1 ? 'holds' : 'hold'} what the athlete
              logged. Copying over {tickedWithResults.length === 1 ? 'it' : 'them'} erases that.
            </p>
          )}
          <div className="flex gap-2 pt-1">
            <Button size="sm" disabled={copying || selectedDates.size === 0} onClick={handleCopy}>
              {copying ? 'Copying…' : `Copy to ${selectedDates.size || 0} day${selectedDates.size === 1 ? '' : 's'}`}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setCopyOpen(false); setSelectedDates(new Set()) }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/** "Last week: 5×5 @140 · RPE 8 → did 140 @8" */
function describeLastWeek(ex: Exercise): string {
  const planned = [
    ex.sets || ex.reps ? `${ex.sets ?? '–'}×${ex.reps ?? '–'}` : '',
    ex.weight != null ? `@${ex.weight}` : '',
    ex.intensity ? `· ${ex.intensity}` : '',
  ].filter(Boolean).join(' ')
  const did = [
    ex.load_used ? ex.load_used : '',
    ex.reps_done ? `×${ex.reps_done}` : '',
    ex.rpe ? `@${ex.rpe}` : '',
  ].filter(Boolean).join(' ')
  return `Last week: ${planned || '—'}${did ? ` → did ${did}` : ''}`
}

const NO_MAXES: StoredMax[] = []

function PlaceholderRow({ colCount, onDrop }: { colCount: number; onDrop: () => void }) {
  return (
    <tr aria-hidden>
      <td
        colSpan={colCount}
        className="py-0.5 px-1"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); onDrop() }}
      >
        <div className="h-7 rounded border-2 border-dashed border-primary/50 bg-primary/5" />
      </td>
    </tr>
  )
}
