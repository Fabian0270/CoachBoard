import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GripVertical, Plus, Trash2 } from 'lucide-react'
import { EXERCISE_NAMES } from 'coachboard-shared/exercises'
import { type Exercise, type ColDef, exerciseValue } from '../../lib/programUtils'
import { failedEditKeyForColumn } from '../../lib/failedEdits'

interface ExerciseRowProps {
  exercise: Exercise
  columns: ColDef[]
  /** Resolves true once the server has stored the change. */
  onSave: (patch: Partial<Exercise>) => Promise<boolean>
  /** Resolves false when the exercise could not be deleted and is still there. */
  onDelete: () => Promise<boolean>
  onAddSet?: () => void
  isSubSet?: boolean
  isInGroup?: boolean
  isDragging?: boolean
  /** `${exerciseId}:${field}` for edits the server has not accepted yet. */
  unsavedKeys?: Set<string>
  onGroupDragStart?: (e: React.DragEvent) => void
  onSetDragStart?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  onDragOverRow?: (e: React.DragEvent) => void
  onDropRow?: () => void
  portalContainer?: HTMLElement | null
}

export default function ExerciseRow({ exercise, columns, onSave, onDelete, onAddSet, isSubSet, isInGroup, isDragging, unsavedKeys, onGroupDragStart, onSetDragStart, onDragEnd, onDragOverRow, onDropRow, portalContainer }: ExerciseRowProps) {
  /**
   * Whether this cell holds a value the server has not accepted.
   *
   * The draft below is local state, so a failed save leaves the typed text
   * sitting in the cell looking exactly like a stored one. This is what tells
   * the two apart — the column-to-field mapping it depends on lives in
   * lib/failedEdits.ts with the tests that pin it.
   */
  const isUnsaved = (key: string): boolean =>
    !!unsavedKeys?.size && unsavedKeys.has(failedEditKeyForColumn(exercise.id, key))
  const unsavedCls = (key: string) =>
    isUnsaved(key) ? ' ring-1 ring-inset ring-destructive bg-destructive/10' : ''
  const initDraft = () => {
    const d: Record<string, string> = {}
    for (const c of columns) d[c.key] = exerciseValue(exercise, c.key)
    return d
  }
  const [draft, setDraft] = useState<Record<string, string>>(initDraft)

  // ── What the coach typed is never dropped ──────────────────────────────
  // A cell shows a local draft and saves when focus leaves it. Two ways that
  // lost work, both reproduced in the 1.17.0 build:
  //
  //   1. Esc closed the day with the cursor still in a cell. A focused element
  //      that unmounts never blurs, so the cell never saved — the day closed
  //      and the server kept the old value.
  //   2. Every draft in the row was reset whenever ANY saved field changed. A
  //      save answering while the coach typed in the next cell put that cell
  //      back to its stored value, and the typed text was never sent.
  //
  // `dirty` is what the coach has typed and not yet handed over. `pending` is
  // what has been handed over and not yet answered — still theirs, not the
  // server's, until the answer lands. Neither is ever overwritten from props.
  const dirtyRef = useRef(new Set<string>())
  const pendingRef = useRef(new Map<string, string>())
  const draftRef = useRef(draft)
  draftRef.current = draft
  const exerciseRef = useRef(exercise)
  exerciseRef.current = exercise
  const columnsRef = useRef(columns)
  columnsRef.current = columns
  const onSaveRef = useRef(onSave)
  onSaveRef.current = onSave
  /** Set when this row is being deleted: there is nothing left to save into. */
  const discardRef = useRef(false)
  // Bumped when a save is answered, so the draft re-reads the stored value.
  const [, setAnswered] = useState(0)

  const edit = (key: string, value: string) => {
    dirtyRef.current.add(key)
    setDraft((d) => ({ ...d, [key]: value }))
  }
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

  // Follow the stored exercise — but only in cells the coach is not in the
  // middle of. Runs after every render on purpose: it is cheap, and a dependency
  // list here is exactly what went stale before.
  useEffect(() => {
    setDraft((prev) => {
      let next = prev
      for (const c of columns) {
        const stored = exerciseValue(exercise, c.key)
        // A pending value the server now agrees with has been answered (a retry
        // of a failed save lands this way, not through the promise above).
        if (pendingRef.current.get(c.key) === stored) pendingRef.current.delete(c.key)
        if (dirtyRef.current.has(c.key) || pendingRef.current.has(c.key)) continue
        if (prev[c.key] !== stored) {
          if (next === prev) next = { ...prev }
          next[c.key] = stored
        }
      }
      return next
    })
  })

  /** Hand one cell's draft to the server, if it differs from what is stored. */
  const commit = (col: ColDef) => {
    const key = col.key
    const v = draftRef.current[key] ?? ''
    dirtyRef.current.delete(key)
    if (v === exerciseValue(exerciseRef.current, key)) return
    let patch: Partial<Exercise>
    if (key === 'name') {
      patch = { name: v }
    } else if (col.numeric) {
      const num = v === '' ? null : Number(v)
      if (num !== null && Number.isNaN(num)) return
      patch = { weight: num }
    } else {
      patch = { [key]: v || null } as Partial<Exercise>
    }
    pendingRef.current.set(key, v)
    void Promise.resolve(onSaveRef.current(patch)).then((saved) => {
      // A failed save stays pending: the cell keeps what was typed (and is
      // marked unsaved) instead of snapping back to the stored value.
      if (!saved || pendingRef.current.get(key) !== v) return
      pendingRef.current.delete(key)
      setAnswered((n) => n + 1)
    })
  }

  // Closing the day (Esc, the ×, paging to another day) unmounts the row with
  // the cursor possibly still in a cell. Save whatever is in hand on the way out.
  useEffect(() => {
    return () => {
      if (discardRef.current) return
      for (const key of [...dirtyRef.current]) {
        const col = columnsRef.current.find((c) => c.key === key)
        if (col) commit(col)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads refs only
  }, [])

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
                      onChange={(e) => edit(c.key, e.target.value)}
                      onFocus={() => setNameFocused(true)}
                      onBlur={() => { commit(c); setNameFocused(false) }}
                      placeholder={c.placeholder}
                      style={textareaStyle}
                      title={
                        isUnsaved(c.key)
                          ? 'Not saved yet — use "Try again" above'
                          : exercise.suggestion_note ?? undefined
                      }
                      className={
                        'w-full bg-transparent px-1 py-1.5 text-sm outline-none focus:bg-accent/30 focus:ring-1 focus:ring-inset focus:ring-primary resize-none block leading-snug' +
                        unsavedCls(c.key)
                      }
                    />
                    {nameMatches.length > 0 && menuRect && portalContainer && createPortal(
                      <ul
                        style={{ position: 'absolute', left: menuRect.left, top: menuRect.top, width: menuRect.width }}
                        className="z-[60] mt-0.5 max-h-56 overflow-auto rounded-lg border bg-popover py-1 text-sm shadow-xl shadow-black/20"
                      >
                        {nameMatches.map((name) => (
                          <li key={name}>
                            <button
                              type="button"
                              // mousedown fires before the textarea blur, so the pick lands.
                              onMouseDown={(e) => {
                                e.preventDefault()
                                edit(c.key, name)
                                draftRef.current = { ...draftRef.current, [c.key]: name }
                                commit(c)
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
        const unsavedTitle = isUnsaved(c.key) ? 'Not saved yet — use "Try again" above' : undefined
        const cellContent = c.numeric ? (
          <input
            type="number"
            min="0"
            step="0.5"
            value={draft[c.key] ?? ''}
            onChange={(e) => edit(c.key, e.target.value)}
            onBlur={() => commit(c)}
            placeholder={c.placeholder}
            title={unsavedTitle}
            className={inputCls + ' num' + unsavedCls(c.key)}
          />
        ) : (
          <textarea
            rows={1}
            value={draft[c.key] ?? ''}
            onChange={(e) => edit(c.key, e.target.value)}
            onBlur={() => commit(c)}
            placeholder={c.placeholder}
            title={unsavedTitle}
            style={textareaStyle}
            className={`${inputCls}${unsavedCls(c.key)} resize-none block leading-snug`}
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
          onClick={() => {
            // Nothing typed in this row should be saved on its way out.
            discardRef.current = true
            void onDelete().then((gone) => { if (!gone) discardRef.current = false })
          }}
          className="p-1 text-muted-foreground hover:text-destructive"
          aria-label="Delete exercise"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </td>
    </tr>
  )
}
