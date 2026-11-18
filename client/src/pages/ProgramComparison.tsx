import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { ApiError, getList, errorMessage, sendJson } from '../lib/api'
import LoadError from '../components/LoadError'
import { Button } from '../components/ui/button'
import PageHeader from '../components/PageHeader'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { useToast } from '../components/ui/toast'
import { useConfirm } from '../components/ui/confirm-dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup,
  DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import { Plus, CopyPlus, Dumbbell, MoreHorizontal, Check, Pencil, X, UserPlus, Star, Search } from 'lucide-react'
import { Input } from '../components/ui/input'
import { matchesSearch } from '../lib/search'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../components/ui/dialog'
import { SuggestProgramDialog } from '../components/suggest-program/SuggestProgramDialog'
import ImportProgramsDialog from '../components/import-programs/ImportProgramsDialog'
import BookmarkStar from '../components/BookmarkStar'
import DuplicateProgramDialog from '../components/DuplicateProgramDialog'
import NewProgramChooser from '../components/NewProgramChooser'
import { cn } from '../lib/utils'

interface Athlete { id: string; name: string }
interface Program { id: string; name: string; status: string; athlete_id: string | null; start_date: string | null; focus?: string | null; bookmarked?: number }

const STATUSES = ['active', 'completed', 'archived'] as const
// Sentinel for the athlete filter's "unassigned" option (Select values must be strings).
const UNASSIGNED = '__unassigned__'

// Shared by the column headings and every row so they line up.
const ROW_GRID = 'sm:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_120px_110px]'

const STATUS_DOT: Record<string, string> = {
  draft: 'bg-warning',
  active: 'bg-primary',
  completed: 'bg-info',
  archived: 'bg-muted-foreground/50',
}

/** A status as a dot + word: quieter than a filled pill in a dense table. */
function StatusBadge({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs capitalize text-muted-foreground">
      <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[status] ?? 'bg-muted-foreground/50')} />
      <span className={status === 'active' ? 'text-foreground' : undefined}>{status}</span>
    </span>
  )
}

export default function ProgramComparison() {
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const [searchParams, setSearchParams] = useSearchParams()
  const [athletes, setAthletes] = useState<Athlete[]>([])
  const [programs, setPrograms] = useState<Program[]>([])
  const [selectedAthlete, setSelectedAthlete] = useState<string>('all')
  const [selectedStatus, setSelectedStatus] = useState<string>('all')
  const [bookmarkedOnly, setBookmarkedOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [duplicating, setDuplicating] = useState<Program | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [savingRename, setSavingRename] = useState(false)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  // The unassigned program being reassigned to an athlete, and the picked target.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [assigning, setAssigning] = useState<Program | null>(null)
  const [assignTo, setAssignTo] = useState<string>('')
  const [savingAssign, setSavingAssign] = useState(false)

  const loadData = useCallback(async () => {
    setLoadError(null)
    try {
      const [fetchedAthletes, fetchedPrograms] = await Promise.all([
        getList<Athlete>('/api/athletes'),
        getList<Program>('/api/programs'),
      ])
      setAthletes(fetchedAthletes)
      setPrograms(fetchedPrograms)
    } catch (err) {
      // Otherwise a failed load renders "No programs yet — create a training
      // program for an athlete" to a coach whose library is the whole reason
      // they bought this.
      setLoadError(errorMessage(err))
    }
  }, [])

  useEffect(() => { void loadData() }, [loadData])

  // Deep link from onboarding: /programs?import=1 opens the bulk-import dialog
  // straight away, then drops the param so a refresh doesn't reopen it.
  useEffect(() => {
    if (searchParams.get('import') === '1') {
      setImportOpen(true)
      searchParams.delete('import')
      setSearchParams(searchParams, { replace: true })
    }
  }, [searchParams, setSearchParams])



  const handleAssign = async () => {
    if (!assigning || !assignTo) return
    setSavingAssign(true)
    try {
      const res = await fetch(`/api/programs/${assigning.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ athlete_id: assignTo }),
      })
      if (res.ok) {
        const updated = await res.json()
        setPrograms((prev) => prev.map((p) => p.id === assigning.id ? { ...p, athlete_id: updated.athlete_id } : p))
        setAssigning(null)
        setAssignTo('')
      } else {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        toast.error(`Failed to assign program: ${err.error ?? JSON.stringify(err)}`)
      }
    } catch (err) {
      toast.error(`Network error: ${String(err)}`)
    } finally {
      setSavingAssign(false)
    }
  }

  const toggleBookmark = async (program: Program, next: boolean) => {
    // Optimistic — flip locally, then persist.
    setPrograms((prev) => prev.map((p) => (p.id === program.id ? { ...p, bookmarked: next ? 1 : 0 } : p)))
    const res = await fetch(`/api/programs/${program.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookmarked: next }),
    })
    if (!res.ok) {
      // Revert on failure.
      setPrograms((prev) => prev.map((p) => (p.id === program.id ? { ...p, bookmarked: next ? 0 : 1 } : p)))
      toast.error('Failed to update bookmark')
    }
  }

  // Both of these used to do nothing at all when the server refused.
  const handleStatusChange = async (programId: string, status: string) => {
    setMenuOpen(null)
    try {
      const updated = await sendJson<{ status: string }>('PUT', `/api/programs/${programId}`, { status })
      setPrograms((prev) => prev.map((p) => p.id === programId ? { ...p, status: updated.status } : p))
    } catch (err) {
      toast.error(`Could not change the status. ${errorMessage(err)}`)
    }
  }

  const handleDelete = async (program: Program) => {
    setMenuOpen(null)
    if (!(await confirm({
      title: `Delete "${program.name}"?`,
      description: 'This will also delete all its workouts and exercises.',
      confirmLabel: 'Delete',
      destructive: true,
    }))) return
    try {
      await sendJson('DELETE', `/api/programs/${program.id}`)
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) {
        toast.error(`Could not delete "${program.name}". ${errorMessage(err)}`)
        return
      }
    }
    setPrograms((prev) => prev.filter((p) => p.id !== program.id))
  }

  const startRename = (program: Program) => {
    setMenuOpen(null)
    setRenameDraft(program.name)
    setRenamingId(program.id)
  }

  const handleRename = async (program: Program) => {
    const trimmed = renameDraft.trim()
    if (trimmed === '' || trimmed === program.name) { setRenamingId(null); return }
    setSavingRename(true)
    try {
      const res = await fetch(`/api/programs/${program.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      if (res.ok) {
        const updated = await res.json()
        setPrograms((prev) => prev.map((p) => p.id === program.id ? { ...p, name: updated.name } : p))
        setRenamingId(null)
      } else {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        toast.error(`Failed to rename program: ${err.error ?? JSON.stringify(err)}`)
      }
    } catch (err) {
      toast.error(`Network error: ${String(err)}`)
    } finally {
      setSavingRename(false)
    }
  }

  const athleteMap = Object.fromEntries(athletes.map((athlete) => [athlete.id, athlete.name]))
  // Resolve a program's owner label: its athlete, "Unassigned" when detached, or
  // "Unknown" if the id no longer resolves (shouldn't happen in normal use).
  const ownerLabel = (p: Program) => (p.athlete_id === null ? 'Unassigned' : athleteMap[p.athlete_id] ?? 'Unknown')
  const filtered = programs
    .filter((p) =>
      selectedAthlete === 'all'
        ? true
        : selectedAthlete === UNASSIGNED
          ? p.athlete_id === null
          : p.athlete_id === selectedAthlete,
    )
    .filter((p) => selectedStatus === 'all' || p.status === selectedStatus)
    .filter((p) => !bookmarkedOnly || p.bookmarked === 1)
    .filter((p) => matchesSearch(query, [p.name, ownerLabel(p), p.focus]))
  const hasUnassigned = programs.some((p) => p.athlete_id === null)
  // Programs exist but the search or filters hide them all. Saying "No programs
  // yet — create one" then would read as the programs being gone.
  const filteredOut = programs.length > 0 && filtered.length === 0

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Programs"
        description={programs.length > 0 ? `${programs.length} program${programs.length === 1 ? '' : 's'}` : undefined}
        actions={
        <>
          <Button onClick={() => setNewMenuOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />New program
          </Button>
        </>
        }
      />
      <div className="flex flex-wrap gap-2">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search programs or athletes"
            aria-label="Search programs"
            className="pl-8"
          />
        </div>
        {(athletes.length > 0 || hasUnassigned) && (
          <Select value={selectedAthlete} onValueChange={setSelectedAthlete}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Athletes</SelectItem>
              {athletes.map((athlete) => <SelectItem key={athlete.id} value={athlete.id}>{athlete.name}</SelectItem>)}
              {hasUnassigned && <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>}
            </SelectContent>
          </Select>
        )}
        <Select value={selectedStatus} onValueChange={setSelectedStatus}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant={bookmarkedOnly ? 'default' : 'outline'}
          onClick={() => setBookmarkedOnly((v) => !v)}
          title="Show only bookmarked programs"
        >
          <Star className={cn('h-4 w-4 mr-2', bookmarkedOnly && 'fill-warning text-warning')} />
          Bookmarked
        </Button>
      </div>
      {loadError ? (
        <LoadError what="your programs" message={loadError} onRetry={() => void loadData()} />
      ) : filteredOut ? (
        <p className="text-sm text-muted-foreground">
          No programs match {query.trim() ? `“${query.trim()}” and ` : ''}the filters above.
        </p>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed bg-card/50 bg-glow-hero py-14 text-center">
          <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary">
            <Dumbbell className="h-6 w-6" />
          </span>
          <h2 className="mb-1 text-lg font-semibold">No programs yet</h2>
          <p className="mb-5 text-sm text-muted-foreground">Create a training program for an athlete.</p>
          <Link to="/programs/new"><Button>New Program</Button></Link>
        </div>
      ) : (
        // No overflow-hidden on the list: it would clip each row's options menu.
        <div className="rounded-xl border bg-card">
          <div className={cn(ROW_GRID, 'hidden gap-4 border-b py-2.5 pl-4 pr-24 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground sm:grid')}>
            <span>Program</span>
            <span>Athlete</span>
            <span>Status</span>
            <span>Started</span>
          </div>
          <ul className="divide-y">
          {filtered.map((program) => (
            <li key={program.id} className="group relative">
              {renamingId === program.id ? (
                <div className="px-4 py-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <input
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRename(program)
                          else if (e.key === 'Escape') setRenamingId(null)
                        }}
                        disabled={savingRename}
                        className="flex-1 min-w-0 rounded-md border border-input bg-background px-2 py-1 text-base font-semibold outline-none focus:ring-2 focus:ring-primary"
                      />
                      <button
                        type="button"
                        onClick={() => handleRename(program)}
                        disabled={savingRename}
                        className="p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                        aria-label="Save name"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setRenamingId(null)}
                        disabled={savingRename}
                        className="p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                        aria-label="Cancel rename"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="mt-1 text-sm text-muted-foreground">{ownerLabel(program)}</div>
                  </div>
                </div>
              ) : (
                <Link
                  to={`/programs/${program.id}`}
                  className={cn(
                    ROW_GRID,
                    'flex flex-col gap-1 px-4 py-3 pr-24 transition-colors duration-150 ease-smooth hover:bg-foreground/[0.03] group-last:rounded-b-xl sm:grid sm:items-center sm:gap-4',
                  )}
                >
                  <span className="truncate font-medium">{program.name}</span>
                  <span className="truncate text-sm text-muted-foreground">{ownerLabel(program)}</span>
                  <span><StatusBadge status={program.status} /></span>
                  <span className="num text-xs text-muted-foreground">{program.start_date ?? '—'}</span>
                </Link>
              )}

              {/* Bookmark star — always visible when bookmarked, on hover otherwise */}
              {renamingId !== program.id && (
                <div
                  className={cn(
                    'absolute right-11 top-1/2 -translate-y-1/2 transition-opacity',
                    program.bookmarked === 1 ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                  )}
                >
                  <BookmarkStar
                    bookmarked={program.bookmarked === 1}
                    onToggle={(next) => toggleBookmark(program, next)}
                  />
                </div>
              )}

              {/* Three-dot menu button */}
              {renamingId !== program.id && (
                <DropdownMenu
                  open={menuOpen === program.id}
                  onOpenChange={(o) => setMenuOpen(o ? program.id : null)}
                >
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={`absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-muted-foreground transition-opacity hover:bg-accent focus:outline-none focus:ring-2 focus:ring-primary focus-visible:opacity-100 ${menuOpen === program.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                      aria-label="Program options"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[160px]">
                    <DropdownMenuLabel>Status</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={program.status}
                      onValueChange={(s) => handleStatusChange(program.id, s as typeof STATUSES[number])}
                    >
                      {STATUSES.map((s) => (
                        <DropdownMenuRadioItem key={s} value={s} className="capitalize">{s}</DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                    {program.athlete_id === null && (
                      <DropdownMenuItem className="py-1.5" onSelect={() => { setAssignTo(''); setAssigning(program) }}>
                        <UserPlus className="h-3 w-3" />Assign to athlete
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem className="py-1.5" onSelect={() => startRename(program)}>
                      <Pencil className="h-3 w-3" />Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem className="py-1.5" onSelect={() => setDuplicating(program)}>
                      <CopyPlus className="h-3 w-3" />Duplicate…
                    </DropdownMenuItem>
                    <DropdownMenuItem className="py-1.5" destructive onSelect={() => handleDelete(program)}>
                      <span className="w-3" />Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </li>
          ))}
          </ul>
        </div>
      )}
      <SuggestProgramDialog
        open={suggestOpen}
        onOpenChange={setSuggestOpen}
        onCreated={(draftId) => navigate(`/programs/${draftId}`)}
      />
      <NewProgramChooser
        open={newMenuOpen}
        onOpenChange={setNewMenuOpen}
        onGenerate={() => setSuggestOpen(true)}
        onImport={() => setImportOpen(true)}
      />
      <DuplicateProgramDialog
        program={duplicating}
        open={duplicating !== null}
        onOpenChange={(o) => { if (!o) setDuplicating(null) }}
      />
      <ImportProgramsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onCreated={(programId) => navigate(`/programs/${programId}`)}
        onImported={loadData}
      />

      <Dialog open={assigning !== null} onOpenChange={(v) => { if (!v && !savingAssign) { setAssigning(null); setAssignTo('') } }}>
        {assigning && (
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Assign “{assigning.name}”</DialogTitle>
              <DialogDescription>Pick the athlete to reuse this program with.</DialogDescription>
            </DialogHeader>
            {athletes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No athletes to assign to — create one first.</p>
            ) : (
              <Select value={assignTo} onValueChange={setAssignTo}>
                <SelectTrigger><SelectValue placeholder="Select an athlete" /></SelectTrigger>
                <SelectContent>
                  {athletes.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={() => { setAssigning(null); setAssignTo('') }} disabled={savingAssign}>
                Cancel
              </Button>
              <Button onClick={handleAssign} disabled={!assignTo || savingAssign}>
                {savingAssign ? 'Assigning…' : 'Assign'}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}
