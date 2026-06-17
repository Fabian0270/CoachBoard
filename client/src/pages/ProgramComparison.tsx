import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Plus, Dumbbell, MoreHorizontal, Check, ChevronDown, Sparkles, FileUp } from 'lucide-react'
import { SuggestProgramDialog } from '../components/SuggestProgramDialog'
import ImportExternalDialog from '../components/ImportExternalDialog'

interface Athlete { id: string; name: string }
interface Program { id: string; name: string; status: string; athlete_id: string; start_date: string | null }

const STATUSES = ['active', 'completed', 'archived'] as const

export default function ProgramComparison() {
  const navigate = useNavigate()
  const [athletes, setAthletes] = useState<Athlete[]>([])
  const [programs, setPrograms] = useState<Program[]>([])
  const [selectedAthlete, setSelectedAthlete] = useState<string>('all')
  const [selectedStatus, setSelectedStatus] = useState<string>('all')
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [importExternalOpen, setImportExternalOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const newMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    Promise.all([
      fetch('/api/athletes').then((r) => r.json()).catch(() => []),
      fetch('/api/programs').then((r) => r.json()).catch(() => []),
    ]).then(([fetchedAthletes, fetchedPrograms]) => {
      setAthletes(Array.isArray(fetchedAthletes) ? fetchedAthletes : [])
      setPrograms(Array.isArray(fetchedPrograms) ? fetchedPrograms : [])
    }).catch(() => {})
  }, [])

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
    if (!confirm(`Delete "${program.name}"? This will also delete all its workouts and exercises.`)) return
    const res = await fetch(`/api/programs/${program.id}`, { method: 'DELETE' })
    if (res.ok || res.status === 404) {
      setPrograms((prev) => prev.filter((p) => p.id !== program.id))
    }
  }

  const filtered = programs
    .filter((p) => selectedAthlete === 'all' || p.athlete_id === selectedAthlete)
    .filter((p) => selectedStatus === 'all' || p.status === selectedStatus)
  const athleteMap = Object.fromEntries(athletes.map((athlete) => [athlete.id, athlete.name]))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Programs</h1>
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
              <button
                type="button"
                onClick={() => { setNewMenuOpen(false); setImportExternalOpen(true) }}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
              >
                <FileUp className="h-4 w-4" />Import external program
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="flex gap-3 flex-wrap">
        {athletes.length > 0 && (
          <Select value={selectedAthlete} onValueChange={setSelectedAthlete}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Athletes</SelectItem>
              {athletes.map((athlete) => <SelectItem key={athlete.id} value={athlete.id}>{athlete.name}</SelectItem>)}
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
              <Link to={`/programs/${program.id}`}>
                <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
                  <CardHeader className="pr-10">
                    <CardTitle className="text-base">{program.name}</CardTitle>
                    <div className="text-sm text-muted-foreground">{athleteMap[program.athlete_id] ?? 'Unknown'}</div>
                  </CardHeader>
                  <CardContent>
                    <Badge variant={program.status === 'active' ? 'default' : 'secondary'}>{program.status}</Badge>
                    {program.start_date && <div className="text-sm text-muted-foreground mt-2">Started: {program.start_date}</div>}
                  </CardContent>
                </Card>
              </Link>

              {/* Three-dot menu button */}
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
      <ImportExternalDialog
        open={importExternalOpen}
        onOpenChange={setImportExternalOpen}
        onCreated={(programId) => navigate(`/programs/${programId}`)}
      />
    </div>
  )
}
