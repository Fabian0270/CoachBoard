import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Dumbbell, Search, Users } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import LoadError from './LoadError'
import { errorMessage, getList } from '../lib/api'
import { foldForSearch, matchesSearch } from '../lib/search'
import { cn } from '../lib/utils'

// Ctrl+K from anywhere: type part of a name and press Enter to go to that
// athlete or program (P1, D89). Athletes and programs only — the sidebar
// already reaches every page. It works mid-typing in the day editor too: the
// field saves when the cursor leaves it, as it does for any click elsewhere,
// and Esc puts the cursor back in it.

interface AthleteRow { id: string; name: string; archived?: number }
interface ProgramRow { id: string; name: string; status: string; athlete_id: string | null; start_date: string | null }

export interface Hit {
  kind: 'athlete' | 'program'
  id: string
  name: string
  detail: string
}

const EMPTY_LIMIT = 5
const LIMIT = 10

/** Names that start with what was typed come before ones that only contain it. */
const startsFirst = (query: string) => {
  const q = foldForSearch(query.trim())
  return (a: { name: string }, b: { name: string }) =>
    Number(!foldForSearch(a.name).startsWith(q)) - Number(!foldForSearch(b.name).startsWith(q))
}

/** What the list shows for a query: athletes first, then programs. */
export function quickSearchHits(query: string, athletes: AthleteRow[], programs: ProgramRow[]): Hit[] {
  const names = new Map(athletes.map((a) => [a.id, a.name]))
  const blank = query.trim() === ''
  const byStart = (a: ProgramRow, b: ProgramRow) => (b.start_date ?? '').localeCompare(a.start_date ?? '')

  // With nothing typed: the coach's current athletes and running programs.
  const people = blank
    ? athletes.filter((a) => !a.archived).slice(0, EMPTY_LIMIT)
    : athletes.filter((a) => matchesSearch(query, [a.name])).sort(startsFirst(query)).slice(0, LIMIT)
  const blocks = blank
    ? programs.filter((p) => p.status === 'active').sort(byStart).slice(0, EMPTY_LIMIT)
    : programs
        .filter((p) => matchesSearch(query, [p.name, p.athlete_id ? names.get(p.athlete_id) : 'template']))
        .sort((a, b) => startsFirst(query)(a, b) || byStart(a, b))
        .slice(0, LIMIT)

  return [
    ...people.map((a): Hit => ({ kind: 'athlete', id: a.id, name: a.name, detail: a.archived ? 'Archived' : '' })),
    ...blocks.map((p): Hit => {
      const owner = p.athlete_id ? names.get(p.athlete_id) ?? '' : 'Template'
      return { kind: 'program', id: p.id, name: p.name, detail: [owner, p.status === 'active' ? '' : p.status].filter(Boolean).join(' · ') }
    }),
  ]
}

export default function QuickSearch() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [at, setAt] = useState(0)
  const [data, setData] = useState<{ athletes: AthleteRow[]; programs: ProgramRow[] } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // Capture phase, so it reaches here even from inside a field or a dialog
  // that handles its own keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return
      e.preventDefault()
      e.stopPropagation()
      setOpen((o) => !o)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const load = () => {
    setLoadError(null)
    Promise.all([getList<AthleteRow>('/api/athletes?include_archived=1'), getList<ProgramRow>('/api/programs')])
      .then(([athletes, programs]) => setData({ athletes, programs }))
      .catch((err) => setLoadError(errorMessage(err)))
  }
  // Fresh every time it opens: a program made a minute ago should be there.
  useEffect(() => { if (open) { setQuery(''); setAt(0); load() } }, [open])

  const hits = useMemo(() => (data ? quickSearchHits(query, data.athletes, data.programs) : []), [data, query])
  useEffect(() => { setAt(0) }, [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-hit="${at}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [at])

  const go = (hit: Hit | undefined) => {
    if (!hit) return
    setOpen(false)
    navigate(hit.kind === 'athlete' ? `/athletes/${hit.id}` : `/programs/${hit.id}`)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (hits.length === 0) return
    const move = (i: number) => { e.preventDefault(); setAt((i + hits.length) % hits.length) }
    if (e.key === 'ArrowDown') move(at + 1)
    else if (e.key === 'ArrowUp') move(at - 1)
    else if (e.key === 'Enter') { e.preventDefault(); go(hits[at]) }
  }

  const firstProgram = hits.findIndex((h) => h.kind === 'program')
  const heading = (label: string) => (
    <li role="presentation" className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</li>
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[15%] max-w-lg gap-0 p-0 [translate:-50%_0]">
        <DialogTitle className="sr-only">Find an athlete or program</DialogTitle>
        <DialogDescription className="sr-only">
          Type part of a name. Up and down choose, Enter opens it.
        </DialogDescription>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Find an athlete or program"
            role="combobox"
            aria-expanded
            aria-controls="quick-search-list"
            aria-activedescendant={hits.length ? `quick-hit-${at}` : undefined}
            aria-label="Find an athlete or program"
            className="h-12 flex-1 bg-transparent pr-8 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {loadError ? (
            <div className="p-3"><LoadError what="your athletes and programs" message={loadError} onRetry={load} /></div>
          ) : data === null ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">Loading…</p>
          ) : hits.length === 0 ? (
            <p className="px-3 py-3 text-sm text-muted-foreground">
              {query.trim() ? `Nothing called “${query.trim()}”.` : 'No athletes or programs yet.'}
            </p>
          ) : (
            <ul id="quick-search-list" role="listbox" aria-label="Results" ref={listRef}>
              {hits.map((hit, i) => (
                <FragmentWithHeading
                  key={`${hit.kind}-${hit.id}`}
                  heading={i === 0 && hit.kind === 'athlete' ? heading('Athletes') : i === firstProgram ? heading(query.trim() ? 'Programs' : 'Running programs') : null}
                >
                  <li
                    id={`quick-hit-${i}`}
                    data-hit={i}
                    role="option"
                    aria-selected={i === at}
                    onMouseMove={() => { if (i !== at) setAt(i) }}
                    onClick={() => go(hit)}
                    className={cn('mx-1 flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-sm', i === at && 'bg-accent')}
                  >
                    {hit.kind === 'athlete'
                      ? <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
                      : <Dumbbell className="h-4 w-4 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1 truncate font-medium">{hit.name}</span>
                    {hit.detail && <span className="shrink-0 text-xs capitalize text-muted-foreground">{hit.detail}</span>}
                  </li>
                </FragmentWithHeading>
              ))}
            </ul>
          )}
        </div>
        <p className="border-t px-3 py-2 text-[11px] text-muted-foreground">↑ ↓ to choose · Enter to open · Esc to close</p>
      </DialogContent>
    </Dialog>
  )
}

function FragmentWithHeading({ heading, children }: { heading: React.ReactNode; children: React.ReactNode }) {
  return <>{heading}{children}</>
}
