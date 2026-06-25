import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GripVertical, Plus, Trash2 } from 'lucide-react'
import { EXERCISE_NAMES } from 'coachboard-shared/exercises'
import { type Exercise, type ColDef, exerciseValue } from '../../lib/programUtils'

interface ExerciseRowProps {
  exercise: Exercise
  columns: ColDef[]
  onSave: (patch: Partial<Exercise>) => void
  onDelete: () => void
  onAddSet?: () => void
  isSubSet?: boolean
  isInGroup?: boolean
  isDragging?: boolean
  onGroupDragStart?: (e: React.DragEvent) => void
  onSetDragStart?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  onDragOverRow?: (e: React.DragEvent) => void
  onDropRow?: () => void
  portalContainer?: HTMLElement | null
}

export default function ExerciseRow({ exercise, columns, onSave, onDelete, onAddSet, isSubSet, isInGroup, isDragging, onGroupDragStart, onSetDragStart, onDragEnd, onDragOverRow, onDropRow, portalContainer }: ExerciseRowProps) {
  const initDraft = () => {
    const d: Record<string, string> = {}
    for (const c of columns) d[c.key] = exerciseValue(exercise, c.key)
    return d
  }
  const [draft, setDraft] = useState<Record<string, string>>(initDraft)
  // Exercise-name autocomplete (exercise directory).
  const [nameFocused, setNameFocused] = useState(false)
  const nameInputRef = useRef<HTMLTextAreaElement>(null)
  // Anchor rect for the suggestion menu, which renders in a portal so it
  // escapes the day dialog's scroll/overflow clipping.
  const [menuRect, setMenuRect] = useState<{ left: number; top: number; width: number } | null>(null)
  const nameQuery = (draft.name ?? '').trim().toLowerCase()
  const nameMatches = nameFocused && nameQuery.length >= 1
    ? EXERCISE_NAMES.filter(
        (n) => n.toLowerCase().includes(nameQuery) && n.toLowerCase() !== nameQuery,
      ).slice(0, 8)
    : []

  useEffect(() => {
    if (nameMatches.length === 0 || !portalContainer) {
      setMenuRect(null)
      return
    }
    // Position the menu absolutely within the dialog content (the portal
    // target), so it tracks the field as the table scrolls underneath.
    const updateRect = () => {
      const el = nameInputRef.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const c = portalContainer.getBoundingClientRect()
      setMenuRect({ left: r.left - c.left, top: r.bottom - c.top, width: Math.max(r.width, 224) })
    }
    updateRect()
    window.addEventListener('scroll', updateRect, true)
    window.addEventListener('resize', updateRect)
    return () => {
      window.removeEventListener('scroll', updateRect, true)
      window.removeEventListener('resize', updateRect)
    }
  }, [nameMatches.length, portalContainer])

  useEffect(() => {
    setDraft(initDraft())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exercise.id, exercise.name, exercise.sets, exercise.reps, exercise.weight, exercise.rest_time, exercise.intensity, exercise.load_used, exercise.rpe, columns.length])

  const commit = (col: ColDef) => {
    const v = draft[col.key] ?? ''
    if (v === exerciseValue(exercise, col.key)) return
    if (col.key === 'name') {
      onSave({ name: v })
    } else if (col.numeric) {
      const num = v === '' ? null : Number(v)
      if (num !== null && Number.isNaN(num)) return
      onSave({ weight: num })
    } else {
      onSave({ [col.key]: v || null } as Partial<Exercise>)
    }
  }

  const inputCls = "w-full bg-transparent px-2 py-1.5 text-sm outline-none focus:bg-accent/30 focus:ring-1 focus:ring-inset focus:ring-primary"
  const textareaStyle: React.CSSProperties = { fieldSizing: 'content' } as React.CSSProperties
  const groupBorder = isInGroup ? 'border-l-2 border-l-primary/30' : ''

  return (
    <tr
      className={isDragging ? 'opacity-30' : undefined}
      onDragOver={onDragOverRow}
      onDrop={onDropRow ? (e) => { e.preventDefault(); onDropRow() } : undefined}
    >
      {columns.flatMap((c) => {
        if (c.key === 'name') {
          return [
            <td key="name" className={`border-b border-r border-border p-0 align-top ${groupBorder}`}>
              {isSubSet ? (
                <div className="flex items-center gap-1 px-2 py-1.5">
                  <span
                    draggable
                    onDragStart={onSetDragStart}
                    onDragEnd={onDragEnd}
                    className="flex-shrink-0 cursor-grab text-muted-foreground/30 hover:text-muted-foreground/60 active:cursor-grabbing"
                  >
                    <GripVertical className="h-3 w-3" />
                  </span>
                  <span className="text-xs text-muted-foreground/40 select-none">↳</span>
                </div>
              ) : (
                <div className="flex items-start">
                  <span
                    draggable
                    onDragStart={onGroupDragStart}
                    onDragEnd={onDragEnd}
                    className="flex-shrink-0 mt-[7px] ml-1 cursor-grab text-muted-foreground/30 hover:text-muted-foreground/60 active:cursor-grabbing"
                  >
                    <GripVertical className="h-3.5 w-3.5" />
                  </span>
                  <div className="relative flex-1 min-w-0">
                    <textarea
                      ref={nameInputRef}
                      rows={1}
                      value={draft[c.key] ?? ''}
                      onChange={(e) => setDraft((d) => ({ ...d, [c.key]: e.target.value }))}
                      onFocus={() => setNameFocused(true)}
                      onBlur={() => { commit(c); setNameFocused(false) }}
                      placeholder={c.placeholder}
                      style={textareaStyle}
                      title={exercise.suggestion_note ?? undefined}
                      className="w-full bg-transparent px-1 py-1.5 text-sm outline-none focus:bg-accent/30 focus:ring-1 focus:ring-inset focus:ring-primary resize-none block leading-snug"
                    />
                    {nameMatches.length > 0 && menuRect && portalContainer && createPortal(
                      <ul
                        style={{ position: 'absolute', left: menuRect.left, top: menuRect.top, width: menuRect.width }}
                        className="z-[60] mt-0.5 max-h-56 overflow-auto rounded-md border bg-card shadow-lg py-1 text-sm"
                      >
                        {nameMatches.map((name) => (
                          <li key={name}>
                            <button
                              type="button"
                              // mousedown fires before the textarea blur, so the pick lands.
                              onMouseDown={(e) => {
                                e.preventDefault()
                                setDraft((d) => ({ ...d, name }))
                                if (name !== exercise.name) onSave({ name })
                                setNameFocused(false)
                              }}
                              className="block w-full px-3 py-1.5 text-left hover:bg-accent"
                            >
                              {name}
                            </button>
                          </li>
                        ))}
                      </ul>,
                      portalContainer,
                    )}
                  </div>
                </div>
              )}
            </td>,
          ]
        }
        const cellContent = c.numeric ? (
          <input
            type="number"
            min="0"
            step="0.5"
            value={draft[c.key] ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, [c.key]: e.target.value }))}
            onBlur={() => commit(c)}
            placeholder={c.placeholder}
            className={inputCls}
          />
        ) : (
          <textarea
            rows={1}
            value={draft[c.key] ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, [c.key]: e.target.value }))}
            onBlur={() => commit(c)}
            placeholder={c.placeholder}
            style={textareaStyle}
            className={`${inputCls} resize-none block leading-snug`}
          />
        )
        const mainTd = (
          <td key={c.key} className="border-b border-r border-border p-0 align-top">
            {cellContent}
          </td>
        )
        if (c.key === 'sets') {
          return [
            mainTd,
            <td key="add-set-col" className="border-b border-r border-border p-0 text-center align-middle">
              {onAddSet && (
                <button
                  type="button"
                  onClick={onAddSet}
                  className="p-1 text-muted-foreground hover:text-primary"
                  aria-label="Add set"
                  title="Add set"
                >
                  <Plus className="h-3 w-3" />
                </button>
              )}
            </td>,
          ]
        }
        return [mainTd]
      })}
      <td className="border-b border-border p-0 text-center align-middle">
        <button
          type="button"
          onClick={onDelete}
          className="p-1 text-muted-foreground hover:text-destructive"
          aria-label="Delete exercise"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  )
}
