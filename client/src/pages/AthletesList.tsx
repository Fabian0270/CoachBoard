import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { getList, errorMessage } from '../lib/api'
import LoadError from '../components/LoadError'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import DeleteAthleteDialog from '../components/DeleteAthleteDialog'
import PageHeader from '../components/PageHeader'
import { Input } from '../components/ui/input'
import { Plus, Search, Users, Trash2, ChevronRight } from 'lucide-react'
import { matchesSearch } from '../lib/search'
import { cn, initials } from '../lib/utils'

interface Athlete {
  id: string
  name: string
  sport: string | null
  email: string | null
  archived: number
  /** The tour's sample athlete (T7): labelled, never mistaken for a real one. */
  is_sample?: number
}

export default function AthletesList() {
  const [athletes, setAthletes] = useState<Athlete[]>([])
  const [loading, setLoading] = useState(true)
  // Separate from `loading` on purpose. With only a loading flag, a failed load
  // is indistinguishable from an empty roster, and this screen's empty state
  // reads "No athletes yet — add your first athlete to get started". A coach
  // with forty athletes seeing that has every reason to think the data is gone.
  const [error, setError] = useState<string | null>(null)
  const [toDelete, setToDelete] = useState<Athlete | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Fetch archived too so the roster can offer a "show archived" toggle without a refetch.
      setAthletes(await getList<Athlete>('/api/athletes?include_archived=1'))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleDelete = (e: React.MouseEvent, athlete: Athlete) => {
    e.preventDefault()
    e.stopPropagation()
    setToDelete(athlete)
  }

  if (loading) return <div className="text-muted-foreground">Loading...</div>

  const active = athletes.filter((a) => !a.archived)
  const archived = athletes.filter((a) => a.archived)
  const searching = query.trim() !== ''
  // A search looks through archived athletes too: looking someone up by name
  // should not depend on remembering whether they were archived.
  const matches = athletes.filter((a) => matchesSearch(query, [a.name, a.email, a.sport]))

  const renderRow = (athlete: Athlete) => (
    <li key={athlete.id} className="group relative">
      <Link
        to={`/athletes/${athlete.id}`}
        className="flex items-center gap-4 px-4 py-3 pr-14 transition-colors duration-150 ease-smooth hover:bg-foreground/[0.03]"
      >
        <span
          aria-hidden
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
            athlete.archived ? 'bg-muted text-muted-foreground' : 'bg-primary/15 text-primary',
          )}
        >
          {initials(athlete.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-medium">
            <span className="truncate">{athlete.name}</span>
            {athlete.archived ? <Badge variant="outline">Archived</Badge> : null}
            {athlete.is_sample ? <Badge variant="outline" className="border-primary/40 text-primary">Sample</Badge> : null}
          </div>
          {athlete.email && <div className="truncate text-xs text-muted-foreground">{athlete.email}</div>}
        </div>
        {athlete.sport && <Badge variant="secondary" className="hidden sm:inline-flex">{athlete.sport}</Badge>}
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
      </Link>
      <button
        type="button"
        onClick={(e) => handleDelete(e, athlete)}
        aria-label={`Delete ${athlete.name}`}
        className="absolute right-10 top-1/2 -translate-y-1/2 rounded-md p-2 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-destructive group-hover:opacity-100 disabled:opacity-50"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </li>
  )

  const renderList = (list: Athlete[]) => (
    <ul className="divide-y overflow-hidden rounded-xl border bg-card">{list.map(renderRow)}</ul>
  )

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Athletes"
        description={!error && active.length > 0 ? `${active.length} active${archived.length ? ` · ${archived.length} archived` : ''}` : undefined}
        actions={<Link to="/athletes/new"><Button><Plus className="h-4 w-4" />New Athlete</Button></Link>}
      />
      {/* The error branch comes FIRST: an empty roster and an unreadable one look
          the same in the data, and only one of them should say "No athletes yet". */}
      {!error && athletes.length > 0 && (
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, email or sport"
            aria-label="Search athletes"
            className="pl-8"
          />
        </div>
      )}
      {error ? (
        <LoadError what="your athletes" message={error} onRetry={() => void load()} />
      ) : searching ? (
        matches.length === 0 ? (
          <p className="text-sm text-muted-foreground">No athletes match “{query.trim()}”.</p>
        ) : (
          renderList(matches)
        )
      ) : active.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-card/50 bg-glow-hero py-14 text-center">
          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary">
            <Users className="h-6 w-6" />
          </span>
          <h2 className="mb-1 text-lg font-semibold">No athletes yet</h2>
          <p className="mb-5 text-sm text-muted-foreground">Add your first athlete to get started.</p>
          <Link to="/athletes/new"><Button>Add Athlete</Button></Link>
        </div>
      ) : (
        renderList(active)
      )}

      {archived.length > 0 && !searching && (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {showArchived ? 'Hide' : 'Show'} archived athletes ({archived.length})
          </button>
          {showArchived && (
            renderList(archived)
          )}
        </div>
      )}

      <DeleteAthleteDialog
        athlete={toDelete}
        open={toDelete !== null}
        onOpenChange={(v) => { if (!v) setToDelete(null) }}
        onDeleted={() => setAthletes((list) => list.filter((a) => a.id !== toDelete?.id))}
      />
    </div>
  )
}
