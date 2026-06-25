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
import ExerciseRow from './ExerciseRow'

interface ExerciseEditorProps {
  workout: Workout | null
  enabledColumns: ToggleableColumn[]
  programId: string
  sameDayDates: { date: string; weekIndex: number }[]
  onAdd: () => void
  onSaveField: (exerciseId: string, patch: Partial<Exercise>) => void
  onDeleteExercise: (exerciseId: string) => void
  onDeleteWorkout: () => void
  onAddSet: (exerciseId: string) => void
  onCopyDay: (targetDates: string[]) => Promise<void>
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

export default function ExerciseEditor({ workout, enabledColumns, programId, sameDayDates, onAdd, onSaveField, onDeleteExercise, onDeleteWorkout, onAddSet, onCopyDay, onReorder }: ExerciseEditorProps) {
  const exercises = workout?.exercises ?? []
  const columns = buildColumns(enabledColumns)
  const [widths, setWidth] = useColumnWidths(programId, columns)
  const activeResizeCleanup = useRef<(() => void) | null>(null)
  const [copyOpen, setCopyOpen] = useState(false)
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
  }, [dragging]) // eslint-disable-line react-hooks/exhaustive-deps

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
      await onCopyDay([...selectedDates])
      setCopyOpen(false)
      setSelectedDates(new Set())
    } finally {
      setCopying(false)
    }
  }

  const groups = buildGroups(exercises)

  return (
    <div className="space-y-3">
      <div
        ref={tableWrapperRef}
        className="overflow-x-auto rounded-md border border-border"
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
          <thead>
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
                          onSave={(patch) => onSaveField(ex.id, patch)}
                          onDelete={() => onDeleteExercise(ex.id)}
                          onAddSet={i === group.exercises.length - 1 ? () => onAddSet(ex.id) : undefined}
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

      {/* Footer: add exercise / clear day / copy to weeks */}
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onAdd}>
            <Plus className="h-4 w-4 mr-1" />Add exercise
          </Button>
          {sameDayDates.length > 0 && exercises.length > 0 && !copyOpen && (
            <Button type="button" size="sm" variant="outline" onClick={() => setCopyOpen(true)}>
              <Copy className="h-4 w-4 mr-1" />Copy to weeks…
            </Button>
          )}
        </div>
        {workout && (
          <Button type="button" size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={onDeleteWorkout}>
            <Trash2 className="h-4 w-4 mr-1" />Clear day
          </Button>
        )}
      </div>

      {/* Inline copy-to-weeks panel */}
      {copyOpen && (
        <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
          <p className="text-sm font-medium">Copy exercises to:</p>
          <div className="space-y-1.5">
            {sameDayDates.map(({ date, weekIndex }) => (
              <label key={date} className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={selectedDates.has(date)}
                  onChange={() => toggleDate(date)}
                />
                Week {weekIndex + 1}
                <span className="text-muted-foreground">{date}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Existing exercises on the target days will be replaced.</p>
          <div className="flex gap-2 pt-1">
            <Button size="sm" disabled={copying || selectedDates.size === 0} onClick={handleCopy}>
              {copying ? 'Copying…' : `Copy to ${selectedDates.size || 0} week${selectedDates.size === 1 ? '' : 's'}`}
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
