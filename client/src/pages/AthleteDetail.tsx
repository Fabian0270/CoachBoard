import { useEffect, useRef, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Textarea } from '../components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { useToast } from '../components/ui/toast'
import DeleteAthleteDialog from '../components/DeleteAthleteDialog'
import AthleteMaxes from '../components/AthleteMaxes'
import PaymentsSection from '../components/PaymentsSection'
import { Plus, ArrowLeft, Trash2, Pencil, ChevronDown, Sparkles, FileUp } from 'lucide-react'
import { SuggestProgramDialog } from '../components/suggest-program/SuggestProgramDialog'
import ImportProgramsDialog from '../components/import-programs/ImportProgramsDialog'

interface Athlete {
  id: string
  name: string
  sport: string | null
  email: string | null
  date_of_birth: string | null
  notes: string | null
}

interface Program {
  id: string
  name: string
  status: string
  start_date: string | null
  focus: string | null
}

export default function AthleteDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const toast = useToast()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [athlete, setAthlete] = useState<Athlete | null>(null)
  const [programs, setPrograms] = useState<Program[]>([])
  const [notFound, setNotFound] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState({ name: '', email: '', sport: '', date_of_birth: '', notes: '' })
  const [saving, setSaving] = useState(false)
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const newMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!id) return
    setNotFound(false)
    Promise.all([
      fetch(`/api/athletes/${id}`).then(async (r) => (r.ok ? r.json() : null)),
      fetch(`/api/programs?athlete_id=${id}`).then((r) => (r.ok ? r.json() : [])),
    ]).then(([athlete, programs]) => {
      if (athlete) setAthlete(athlete)
      else setNotFound(true)
      setPrograms(Array.isArray(programs) ? programs : [])
    }).catch(() => {})
  }, [id])

  useEffect(() => {
    if (!newMenuOpen) return
    const close = () => setNewMenuOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [newMenuOpen])

  const handleDelete = () => setDeleteOpen(true)

  const startEdit = () => {
    if (!athlete) return
    setEditForm({
      name: athlete.name,
      email: athlete.email ?? '',
      sport: athlete.sport ?? '',
      date_of_birth: athlete.date_of_birth ?? '',
      notes: athlete.notes ?? '',
    })
    setEditing(true)
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!id) return
    setSaving(true)
    try {
      const res = await fetch(`/api/athletes/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm),
      })
      if (res.ok) {
        const updated = await res.json()
        setAthlete(updated)
        setEditing(false)
      } else {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        toast.error(`Failed to save: ${err.error ?? JSON.stringify(err)}`)
      }
    } catch (err) {
      toast.error(`Network error: ${String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  if (notFound) {
    return (
      <div className="space-y-3">
        <p className="text-muted-foreground">Athlete not found — they may have been deleted.</p>
        <Link to="/athletes" className="text-primary underline">Back to athletes</Link>
      </div>
    )
  }
  if (!athlete) return <div className="text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/athletes"><ArrowLeft className="h-5 w-5 text-muted-foreground" /></Link>
          <h1 className="text-3xl font-bold">{athlete.name}</h1>
          {athlete.sport && <Badge variant="secondary">{athlete.sport}</Badge>}
        </div>
        <Button variant="destructive" size="sm" onClick={handleDelete}><Trash2 className="h-4 w-4" /></Button>
      </div>
      <Tabs defaultValue="info">
        <TabsList>
          <TabsTrigger value="info">Info</TabsTrigger>
          <TabsTrigger value="programs">Programs ({programs.length})</TabsTrigger>
          <TabsTrigger value="maxes">Maxes &amp; RPE</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
        </TabsList>
        <TabsContent value="info">
          <Card>
            {editing ? (
              <CardContent className="p-6">
                <form onSubmit={handleSave} className="space-y-4">
                  <div className="space-y-1">
                    <Label htmlFor="edit-name">Name *</Label>
                    <Input id="edit-name" required value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="edit-email">Email</Label>
                    <Input id="edit-email" type="email" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="edit-sport">Sport</Label>
                    <Input id="edit-sport" value={editForm.sport} onChange={(e) => setEditForm({ ...editForm, sport: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="edit-dob">Date of Birth</Label>
                    <Input id="edit-dob" type="date" value={editForm.date_of_birth} onChange={(e) => setEditForm({ ...editForm, date_of_birth: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="edit-notes">Notes</Label>
                    <Textarea id="edit-notes" value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} />
                  </div>
                  <div className="flex gap-2">
                    <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
                    <Button type="button" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
                  </div>
                </form>
              </CardContent>
            ) : (
              <CardContent className="p-6 space-y-3">
                <div className="flex justify-end">
                  <Button type="button" variant="outline" size="sm" onClick={startEdit}>
                    <Pencil className="h-4 w-4 mr-1" />Edit
                  </Button>
                </div>
                {athlete.email && <div><span className="font-medium">Email:</span> {athlete.email}</div>}
                {athlete.sport && <div><span className="font-medium">Sport:</span> {athlete.sport}</div>}
                {athlete.date_of_birth && <div><span className="font-medium">Date of Birth:</span> {athlete.date_of_birth}</div>}
                {athlete.notes && <div><span className="font-medium">Notes:</span> {athlete.notes}</div>}
                {!athlete.email && !athlete.sport && !athlete.date_of_birth && !athlete.notes && (
                  <p className="text-muted-foreground text-sm">No details yet.</p>
                )}
              </CardContent>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="programs">
          <div className="space-y-3">
            <div className="relative inline-block" ref={newMenuRef}>
              <Button size="sm" onClick={(e) => { e.stopPropagation(); setNewMenuOpen((v) => !v) }}>
                <Plus className="h-4 w-4 mr-2" />New Program<ChevronDown className="h-4 w-4 ml-2" />
              </Button>
              {newMenuOpen && (
                <div className="absolute left-0 top-full mt-1 z-20 min-w-[200px] rounded-md border bg-card shadow-lg py-1" onClick={(e) => e.stopPropagation()}>
                  <Link to={`/programs/new?athlete_id=${id}`} onClick={() => setNewMenuOpen(false)}>
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
                    onClick={() => { setNewMenuOpen(false); setImportOpen(true) }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-accent"
                  >
                    <FileUp className="h-4 w-4" />Import program
                  </button>
                </div>
              )}
            </div>
            {programs.length === 0 ? (
              <Card><CardContent className="py-8 text-center text-muted-foreground">No programs yet.</CardContent></Card>
            ) : programs.map((program) => (
              <Link key={program.id} to={`/programs/${program.id}`} className="block">
                <Card className="hover:shadow-md transition-shadow cursor-pointer">
                  <CardHeader className="py-4">
                    <CardTitle className="text-base">{program.name}</CardTitle>
                    <div className="flex gap-1.5">
                      <Badge variant={program.status === 'active' ? 'default' : 'secondary'}>{program.status}</Badge>
                      {program.focus && <Badge variant="outline" className="capitalize">{program.focus}</Badge>}
                    </div>
                  </CardHeader>
                </Card>
              </Link>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="maxes">
          {id && <AthleteMaxes athleteId={id} />}
        </TabsContent>
        <TabsContent value="payments">
          {id && <PaymentsSection athleteId={id} />}
        </TabsContent>
      </Tabs>
      {id && (
        <SuggestProgramDialog
          open={suggestOpen}
          onOpenChange={setSuggestOpen}
          athleteId={id}
          onCreated={(draftId) => navigate(`/programs/${draftId}`)}
        />
      )}
      {id && (
        <ImportProgramsDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          defaultAthleteId={id}
          onCreated={(programId) => navigate(`/programs/${programId}`)}
          onImported={() => {
            fetch(`/api/programs?athlete_id=${id}`)
              .then((r) => (r.ok ? r.json() : []))
              .then((data) => setPrograms(Array.isArray(data) ? data : []))
              .catch(() => {})
          }}
        />
      )}
      <DeleteAthleteDialog
        athlete={athlete}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => navigate('/athletes')}
      />
    </div>
  )
}
