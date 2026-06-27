import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { useToast } from '../components/ui/toast'
import { useConfirm } from '../components/ui/confirm-dialog'
import { Plus, Dumbbell, MoreHorizontal, Check, ChevronDown, Sparkles, FileUp, Pencil, X, UserPlus } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../components/ui/dialog'
import { SuggestProgramDialog } from '../components/suggest-program/SuggestProgramDialog'
import ImportProgramsDialog from '../components/import-programs/ImportProgramsDialog'

interface Athlete { id: string; name: string }
interface Program { id: string; name: string; status: string; athlete_id: string | null; start_date: string | null }

const STATUSES = ['active', 'completed', 'archived'] as const
// Sentinel for the athlete filter's "unassigned" option (Select values must be strings).
const UNASSIGNED = '__unassigned__'

export default function ProgramComparison() {
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const [searchParams, setSearchParams] = useSearchParams()
  const [athletes, setAthletes] = useState<Athlete[]>([])
  const [programs, setPrograms] = useState<Program[]>([])
  const [selectedAthlete, setSelectedAthlete] = useState<string>('all')
  const [selectedStatus, setSelectedStatus] = useState<string>('all')
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [savingRename, setSavingRename] = useState(false)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  // The unassigned program being reassigned to an athlete, and the picked target.
  const [assigning, setAssigning] = useState<Program | null>(null)
  const [assignTo, setAssignTo] = useState<string>('')
  const [savingAssign, setSavingAssign] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const newMenuRef = useRef<HTMLDivElement>(null)

  const loadData = () => {
    Promise.all([
      fetch('/api/athletes').then((r) => r.json()).catch(() => []),
      fetch('/api/programs').then((r) => r.json()).catch(() => []),
    ]).then(([fetchedAthletes, fetchedPrograms]) => {
      setAthletes(Array.isArray(fetchedAthletes) ? fetchedAthletes : [])
      setPrograms(Array.isArray(fetchedPrograms) ? fetchedPrograms : [])
    }).catch(() => {})
  }

  useEffect(() => { loadData() }, [])

  // Deep link from onboarding: /programs?import=1 opens the bulk-import dialog
  // straight away, then drops the param so a refresh doesn't reopen it.
  useEffect(() => {
    if (searchParams.get('import') === '1') {
      setImportOpen(true)
      searchParams.delete('import')
      setSearchParams(searchParams, { replace: true })
    }
  }, [searchParams, setSearchParams])

  useEffect(() => {
    if (!menuOpen) return
    const close = () => setMenuOpen(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuOpen])

  useEffect(() => {
    if (!newMenuOpen) return
    const close = () => setNewMenuOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [newMenuOpen])

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

  const handleStatusChange = async (programId: string, status: string) => {
    setMenuOpen(null)
    const res = await fetch(`/api/programs/${programId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    if (res.ok) {
      const updated = await res.json()
      setPrograms((prev) => prev.map((p) => p.id === programId ? { ...p, status: updated.status } : p))
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
    const res = await fetch(`/api/programs/${program.id}`, { method: 'DELETE' })
    if (res.ok || res.status === 404) {
      setPrograms((prev) => prev.filter((p) => p.id !== program.id))
    }
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

  const filtered = programs
    .filter((p) =>
      selectedAthlete === 'all'
        ? true
        : selectedAthlete === UNASSIGNED
          ? p.athlete_id === null
          : p.athlete_id === selectedAthlete,
    )
    .filter((p) => selectedStatus === 'all' || p.status === selectedStatus)
  const athleteMap = Object.fromEntries(athletes.map((athlete) => [athlete.id, athlete.name]))
  const hasUnassigned = programs.some((p) => p.athlete_id === null)
  // Resolve a program's owner label: its athlete, "Unassigned" when detached, or
  // "Unknown" if the id no longer resolves (shouldn't happen in normal use).
  const ownerLabel = (p: Program) => (p.athlete_id === null ? 'Unassigned' : athleteMap[p.athlete_id] ?? 'Unknown')

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Programs</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <FileUp className="h-4 w-4 mr-2" />Import programs
          </Button>
          <div className="relative" ref={newMenuRef}>
            <Button onClick={(e) => { e.stopPropagation(); setNewMenuOpen((v) => !v) }}>
              <Plus className="h-4 w-4 mr-2" />New Program<ChevronDown className="h-4 w-4 ml-2" />
            </Button>
            {newMenuOpen && (
              <div className="absolute right-0 top-full mt-1 z-20 min-w-[200px] rounded-md border bg-card shadow-lg py-1" onClick={(e) => e.stopPropagation()}>
                <Link to="/programs/new" onClick={() => setNewMenuOpen(false)}>
                  <button type="button" className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent">
                    <Plus className="h-4 w-4" />New program
                  </button>
                </Link>
                <button
                  type="button"
                  onClick={() => { setNewMenuOpen(false); setSuggestOpen(true) }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
                >
                  <Sparkles className="h-4 w-4" />Generate next program
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="flex gap-3 flex-wrap">
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
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Dumbbell className="h-12 w-12 text-muted-foreground mb-4" />
            <h2 className="text-lg font-semibold mb-2">No programs yet</h2>
            <p className="text-muted-foreground mb-4">Create a training program for an athlete.</p>
            <Link to="/programs/new"><Button>New Program</Button></Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((program) => (
            <div key={program.id} className="relative group" ref={menuOpen === program.id ? menuRef : null}>
              {renamingId === program.id ? (
                <Card className="h-full">
                  <CardHeader className="pr-4">
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
                    <div className="text-sm text-muted-foreground">{ownerLabel(program)}</div>
                  </CardHeader>
                  <CardContent>
                    <Badge variant={program.status === 'active' ? 'default' : 'secondary'}>{program.status}</Badge>
                    {program.start_date && <div className="text-sm text-muted-foreground mt-2">Started: {program.start_date}</div>}
                  </CardContent>
                </Card>
              ) : (
                <Link to={`/programs/${program.id}`}>
                  <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
                    <CardHeader className="pr-10">
                      <CardTitle className="text-base">{program.name}</CardTitle>
                      <div className="text-sm text-muted-foreground">{ownerLabel(program)}</div>
                    </CardHeader>
                    <CardContent>
                      <Badge variant={program.status === 'active' ? 'default' : 'secondary'}>{program.status}</Badge>
                      {program.start_date && <div className="text-sm text-muted-foreground mt-2">Started: {program.start_date}</div>}
                    </CardContent>
                  </Card>
                </Link>
              )}

              {/* Three-dot menu button */}
              {renamingId !== program.id && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setMenuOpen(menuOpen === program.id ? null : program.id)
                  }}
                  className={`absolute top-3 right-3 p-1.5 rounded-md text-muted-foreground transition-opacity hover:bg-accent focus:outline-none focus:ring-2 focus:ring-primary ${menuOpen === program.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                  aria-label="Program options"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              )}

              {/* Dropdown menu */}
              {menuOpen === program.id && (
                <div
                  className="absolute top-10 right-3 z-20 min-w-[160px] rounded-md border border-border bg-card shadow-lg py-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <p className="px-3 py-1 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Status</p>
                  {STATUSES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => handleStatusChange(program.id, s)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent capitalize"
                    >
                      <span className="w-3">
                        {program.status === s && <Check className="h-3 w-3" />}
                      </span>
                      {s}
                    </button>
                  ))}
                  <div className="my-1 border-t border-border" />
                  {program.athlete_id === null && (
                    <button
                      type="button"
                      onClick={() => { setMenuOpen(null); setAssignTo(''); setAssigning(program) }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent"
                    >
                      <UserPlus className="h-3 w-3" />
                      Assign to athlete
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => startRename(program)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent"
                  >
                    <Pencil className="h-3 w-3" />
                    Rename
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(program)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
                  >
                    <span className="w-3" />
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <SuggestProgramDialog
        open={suggestOpen}
        onOpenChange={setSuggestOpen}
        onCreated={(draftId) => navigate(`/programs/${draftId}`)}
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
