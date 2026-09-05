import { useEffect, useRef, useState } from 'react'
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom'
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
import SavedAnalyses from '../components/analysis/SavedAnalyses'
import PaymentsSection from '../components/PaymentsSection'
import AthleteMediaSection from '../components/discord/AthleteMediaSection'
import AthleteMessagesSection from '../components/discord/AthleteMessagesSection'
import SlideIn from '../components/SlideIn'
import BookmarkStar from '../components/BookmarkStar'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '../components/ui/select'
import { WEIGHT_CLASSES, isPowerlifting } from 'coachboard-shared'
import { useDiscordConfigured } from '../hooks/useDiscordConfigured'
import type { DiscordUserItem } from 'coachboard-shared/discord'
import { Plus, ArrowLeft, Trash2, Pencil, ChevronDown, Sparkles, FileUp } from 'lucide-react'
import { SuggestProgramDialog } from '../components/suggest-program/SuggestProgramDialog'
import ImportProgramsDialog from '../components/import-programs/ImportProgramsDialog'

interface Athlete {
  id: string
  name: string
  sport: string | null
  weight_class: string | null
  height_cm: number | null
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
  bookmarked?: number
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
  const [editForm, setEditForm] = useState({ name: '', email: '', sport: '', weight_class: '', height_cm: '', date_of_birth: '', notes: '' })
  const [saving, setSaving] = useState(false)
  const { configured: discordConfigured } = useDiscordConfigured()
  const [discordUsernames, setDiscordUsernames] = useState<string[]>([])
  const [searchParams] = useSearchParams()
  const initialTab = searchParams.get('tab') ?? 'info'
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

  // Linked Discord account(s) for this athlete — shown read-only in Info.
  useEffect(() => {
    if (!id || !discordConfigured) {
      setDiscordUsernames([])
      return
    }
    let cancelled = false
    fetch('/api/discord/users')
      .then((r) => (r.ok ? r.json() : []))
      .then((users: DiscordUserItem[]) => {
        if (!cancelled) {
          setDiscordUsernames(users.filter((u) => u.athleteId === id).map((u) => u.username))
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [id, discordConfigured])

  const handleDelete = () => setDeleteOpen(true)

  const toggleBookmark = async (program: Program, next: boolean) => {
    setPrograms((prev) => prev.map((p) => (p.id === program.id ? { ...p, bookmarked: next ? 1 : 0 } : p)))
    const res = await fetch(`/api/programs/${program.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookmarked: next }),
    })
    if (!res.ok) {
      setPrograms((prev) => prev.map((p) => (p.id === program.id ? { ...p, bookmarked: next ? 0 : 1 } : p)))
      toast.error('Failed to update bookmark')
    }
  }

  const startEdit = () => {
    if (!athlete) return
    setEditForm({
      name: athlete.name,
      email: athlete.email ?? '',
      sport: athlete.sport ?? '',
      weight_class: athlete.weight_class ?? '',
      height_cm: athlete.height_cm != null ? String(athlete.height_cm) : '',
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
      <Tabs defaultValue={initialTab}>
        <TabsList>
          <TabsTrigger value="info">Info</TabsTrigger>
          <TabsTrigger value="programs">Programs ({programs.length})</TabsTrigger>
          <TabsTrigger value="maxes">Maxes &amp; RPE</TabsTrigger>
          <TabsTrigger value="barpath">Bar path</TabsTrigger>
          {discordConfigured && <TabsTrigger value="videos">Videos</TabsTrigger>}
          {discordConfigured && <TabsTrigger value="messages">Messages</TabsTrigger>}
          <TabsTrigger value="payments">Payments</TabsTrigger>
        </TabsList>
        <TabsContent value="info">
          <SlideIn>
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
                  {isPowerlifting(editForm.sport) && (
                    <div className="space-y-1">
                      <Label htmlFor="edit-weight-class">Weight class</Label>
                      <Select value={editForm.weight_class} onValueChange={(v) => setEditForm({ ...editForm, weight_class: v })}>
                        <SelectTrigger id="edit-weight-class"><SelectValue placeholder="Select weight class…" /></SelectTrigger>
                        <SelectContent>
                          {WEIGHT_CLASSES.men.map((w) => <SelectItem key={`m${w}`} value={w}>{w} kg (men)</SelectItem>)}
                          {WEIGHT_CLASSES.women.map((w) => <SelectItem key={`w${w}`} value={w}>{w} kg (women)</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                  <div className="space-y-1">
                    <Label htmlFor="edit-height">Height (cm)</Label>
                    <Input
                      id="edit-height"
                      type="number"
                      min={120}
                      max={230}
                      placeholder="e.g. 180"
                      value={editForm.height_cm}
                      onChange={(e) => setEditForm({ ...editForm, height_cm: e.target.value })}
                    />
                    <p className="text-xs text-muted-foreground">
                      Optional. Bar-path analysis uses it to check the plate scale — the bar
                      travels a distance their build decides, so a wrong scale shows up.
                    </p>
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
                {isPowerlifting(athlete.sport) && athlete.weight_class && (
                  <div><span className="font-medium">Weight class:</span> {athlete.weight_class} kg</div>
                )}
                {athlete.height_cm != null && (
                  <div><span className="font-medium">Height:</span> {athlete.height_cm} cm</div>
                )}
                {athlete.date_of_birth && <div><span className="font-medium">Date of Birth:</span> {athlete.date_of_birth}</div>}
                {discordUsernames.length > 0 && (
                  <div><span className="font-medium">Discord:</span> {discordUsernames.map((u) => `@${u}`).join(', ')}</div>
                )}
                {athlete.notes && <div><span className="font-medium">Notes:</span> {athlete.notes}</div>}
                {!athlete.email && !athlete.sport && !athlete.date_of_birth && !athlete.notes && discordUsernames.length === 0 && (
                  <p className="text-muted-foreground text-sm">No details yet.</p>
                )}
              </CardContent>
            )}
          </Card>
          </SlideIn>
        </TabsContent>
        <TabsContent value="programs">
          <SlideIn>
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
              <div key={program.id} className="group relative">
                <Link to={`/programs/${program.id}`} className="block">
                  <Card className="hover:shadow-md transition-shadow cursor-pointer">
                    <CardHeader className="py-4 pr-10">
                      <CardTitle className="text-base">{program.name}</CardTitle>
                      <div className="flex gap-1.5">
                        <Badge variant={program.status === 'active' ? 'default' : 'secondary'}>{program.status}</Badge>
                        {program.focus && <Badge variant="outline" className="capitalize">{program.focus}</Badge>}
                      </div>
                    </CardHeader>
                  </Card>
                </Link>
                <div
                  className={
                    program.bookmarked === 1
                      ? 'absolute top-3 right-3'
                      : 'absolute top-3 right-3 opacity-0 transition-opacity group-hover:opacity-100'
                  }
                >
                  <BookmarkStar
                    bookmarked={program.bookmarked === 1}
                    onToggle={(next) => toggleBookmark(program, next)}
                  />
                </div>
              </div>
            ))}
          </div>
          </SlideIn>
        </TabsContent>
        <TabsContent value="maxes">
          <SlideIn>{id && <AthleteMaxes athleteId={id} />}</SlideIn>
        </TabsContent>
        <TabsContent value="barpath">
          <SlideIn>
            <Card>
              <CardHeader className="py-4">
                <CardTitle className="text-base">Bar path history</CardTitle>
              </CardHeader>
              <CardContent className="p-6 pt-0">
                {id && <SavedAnalyses athleteId={id} />}
              </CardContent>
            </Card>
          </SlideIn>
        </TabsContent>
        {discordConfigured && (
          <TabsContent value="videos">
            <SlideIn>{id && <AthleteMediaSection athleteId={id} />}</SlideIn>
          </TabsContent>
        )}
        {discordConfigured && (
          <TabsContent value="messages">
            <SlideIn>{id && <AthleteMessagesSection athleteId={id} />}</SlideIn>
          </TabsContent>
        )}
        <TabsContent value="payments">
          <SlideIn>{id && <PaymentsSection athleteId={id} />}</SlideIn>
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
