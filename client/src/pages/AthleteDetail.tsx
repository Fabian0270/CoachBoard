import { useEffect, useState } from 'react'
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
import AthleteProgress from '../components/AthleteProgress'
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
import { Plus, Trash2, Pencil } from 'lucide-react'
import { cn, initials } from '../lib/utils'
import { BackLink } from '../components/PageHeader'

/** One labelled fact in the athlete's Info tab. */
function InfoField({ label, mono, className, children }: { label: string; mono?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('min-w-0 space-y-1', className)}>
      <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd className={cn('break-words text-sm', mono && 'num')}>{children}</dd>
    </div>
  )
}
import { SuggestProgramDialog } from '../components/suggest-program/SuggestProgramDialog'
import ImportProgramsDialog from '../components/import-programs/ImportProgramsDialog'
import NewProgramChooser from '../components/NewProgramChooser'
import LoadError from '../components/LoadError'
import AthleteUnitSwitch from '../components/AthleteUnitSwitch'
import { unitOf } from 'coachboard-shared/units'
import { ApiError, errorMessage, getJson, getList } from '../lib/api'

interface Athlete {
  id: string
  name: string
  sport: string | null
  weight_class: string | null
  height_cm: number | null
  unit?: string
  email: string | null
  date_of_birth: string | null
  notes: string | null
  /** The tour's sample athlete (T7). */
  is_sample?: number
}

interface Program {
  id: string
  name: string
  status: string
  start_date: string | null
  focus: string | null
  bookmarked?: number
}

/**
 * One page per athlete, as with programs: going straight from one athlete to
 * another (Ctrl+K) kept the page mounted, showing the previous athlete under
 * the new address until the new one loaded, with its dialogs still open.
 */
export default function AthleteDetail() {
  const { id } = useParams<{ id: string }>()
  return <AthletePage key={id} />
}

function AthletePage() {
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
  // Follows ?tab= when it changes on the same page — the tour goes from one
  // tab to the next by address — and clicking a tab still just switches.
  const [tab, setTab] = useState(initialTab)
  useEffect(() => { setTab(searchParams.get('tab') ?? 'info') }, [searchParams])
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [unitEpoch, setUnitEpoch] = useState(0)

  // Any failure used to read as "Athlete not found — they may have been
  // deleted" (or a page stuck on Loading), and a failed program list as "No
  // programs yet". Only a 404 means the athlete is gone.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [programsError, setProgramsError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const loadPrograms = async (athleteId: string, isCurrent: () => boolean = () => true) => {
    try {
      const rows = await getList<Program>(`/api/programs?athlete_id=${encodeURIComponent(athleteId)}`)
      if (!isCurrent()) return
      setPrograms(rows)
      setProgramsError(null)
    } catch (err) {
      if (isCurrent()) setProgramsError(errorMessage(err))
    }
  }

  useEffect(() => {
    if (!id) return
    let cancelled = false
    setNotFound(false)
    setLoadError(null)
    getJson<Athlete>(`/api/athletes/${encodeURIComponent(id)}`)
      .then((a) => { if (!cancelled) setAthlete(a) })
      .catch((err) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 404) setNotFound(true)
        else setLoadError(errorMessage(err))
      })
    void loadPrograms(id, () => !cancelled)
    return () => { cancelled = true }
  }, [id, attempt])


  // Linked Discord account(s) for this athlete — shown read-only in Info.
  useEffect(() => {
    if (!id || !discordConfigured) {
      setDiscordUsernames([])
      return
    }
    let cancelled = false
    // A read-only nicety on the Info tab; on failure it is left out rather
    // than claiming the athlete has no linked account.
    getList<DiscordUserItem>('/api/discord/users')
      .then((users) => {
        if (!cancelled) {
          setDiscordUsernames(users.filter((u) => u.athleteId === id).map((u) => u.username))
        }
      })
      .catch(() => { if (!cancelled) setDiscordUsernames([]) })
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
  if (!athlete && loadError) {
    return <LoadError what="this athlete" message={loadError} onRetry={() => setAttempt((n) => n + 1)} />
  }
  if (!athlete) return <div className="text-muted-foreground">Loading...</div>

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <BackLink to="/athletes">Athletes</BackLink>
      {/* Profile header: who this is at a glance, on the same glow as the hero figures. */}
      <section data-tour="athlete-header" className="flex flex-wrap items-center gap-5 rounded-xl border bg-card bg-glow-hero px-6 py-5">
        <span
          aria-hidden
          className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary/15 text-lg font-semibold text-primary"
        >
          {initials(athlete.name)}
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <h1 className="truncate text-[26px] font-semibold leading-tight tracking-tight">{athlete.name}</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {athlete.is_sample ? <Badge variant="outline" className="border-primary/40 text-primary" title="A made-up athlete for trying CoachBoard. Remove it from Settings → Help.">Sample</Badge> : null}
            {athlete.sport && <Badge variant="default">{athlete.sport}</Badge>}
            {isPowerlifting(athlete.sport) && athlete.weight_class && <span className="num">{athlete.weight_class} kg</span>}
            {athlete.email && <span className="truncate">{athlete.email}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* kg or lb (S3, D77): switching can convert their numbers. */}
          <AthleteUnitSwitch athlete={athlete} onChanged={(a) => { setAthlete(a); setUnitEpoch((n) => n + 1) }} />
          <Button variant="outline" size="sm" onClick={startEdit}><Pencil className="h-3.5 w-3.5" />Edit</Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleDelete}
            aria-label="Delete athlete"
            className="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </section>
      {/* Remounted after a unit switch, so every tab reads the numbers again. */}
      <Tabs key={unitEpoch} value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="info">Info</TabsTrigger>
          <TabsTrigger value="programs">Programs ({programs.length})</TabsTrigger>
          <TabsTrigger value="progress">Progress</TabsTrigger>
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
              <CardContent className="p-6">
                {!athlete.email && !athlete.sport && !athlete.date_of_birth && !athlete.notes && discordUsernames.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No details yet.</p>
                ) : (
                  <dl className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-3">
                    {athlete.email && <InfoField label="Email">{athlete.email}</InfoField>}
                    {athlete.sport && <InfoField label="Sport">{athlete.sport}</InfoField>}
                    {isPowerlifting(athlete.sport) && athlete.weight_class && (
                      <InfoField label="Weight class" mono>{athlete.weight_class} kg</InfoField>
                    )}
                    {athlete.height_cm != null && <InfoField label="Height" mono>{athlete.height_cm} cm</InfoField>}
                    {athlete.date_of_birth && <InfoField label="Date of birth" mono>{athlete.date_of_birth}</InfoField>}
                    {discordUsernames.length > 0 && (
                      <InfoField label="Discord">{discordUsernames.map((u) => `@${u}`).join(', ')}</InfoField>
                    )}
                    {athlete.notes && (
                      <InfoField label="Notes" className="sm:col-span-2 lg:col-span-3">
                        <span className="whitespace-pre-wrap">{athlete.notes}</span>
                      </InfoField>
                    )}
                  </dl>
                )}
              </CardContent>
            )}
          </Card>
          </SlideIn>
        </TabsContent>
        <TabsContent value="programs">
          <SlideIn>
          <div className="space-y-3">
            <Button size="sm" onClick={() => setNewMenuOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />New program
            </Button>
            {id && (
              <NewProgramChooser
                open={newMenuOpen}
                onOpenChange={setNewMenuOpen}
                athleteId={id}
                onGenerate={() => setSuggestOpen(true)}
                onImport={() => setImportOpen(true)}
              />
            )}
            {programsError ? (
              <LoadError what="this athlete's programs" message={programsError} onRetry={() => { if (id) void loadPrograms(id) }} />
            ) : programs.length === 0 ? (
              <div className="rounded-xl border border-dashed bg-card/50 py-10 text-center text-sm text-muted-foreground">No programs yet.</div>
            ) : (
              <ul className="divide-y overflow-hidden rounded-xl border bg-card">
                {programs.map((program) => (
                  <li key={program.id} className="group relative">
                    <Link
                      to={`/programs/${program.id}`}
                      className="flex items-center gap-4 px-4 py-3 pr-14 transition-colors duration-150 ease-smooth hover:bg-foreground/[0.03]"
                    >
                      <span className="min-w-0 flex-1 truncate font-medium">{program.name}</span>
                      {program.focus && <Badge variant="outline" className="hidden capitalize sm:inline-flex">{program.focus}</Badge>}
                      <Badge variant={program.status === 'active' ? 'default' : 'secondary'} className="capitalize">{program.status}</Badge>
                    </Link>
                    <div
                      className={
                        program.bookmarked === 1
                          ? 'absolute right-3 top-1/2 -translate-y-1/2'
                          : 'absolute right-3 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100'
                      }
                    >
                      <BookmarkStar
                        bookmarked={program.bookmarked === 1}
                        onToggle={(next) => toggleBookmark(program, next)}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          </SlideIn>
        </TabsContent>
        <TabsContent value="progress">
          <SlideIn>{id && <AthleteProgress athleteId={id} unit={unitOf(athlete.unit)} />}</SlideIn>
        </TabsContent>
        <TabsContent value="maxes" data-tour="athlete-maxes">
          <SlideIn>{id && <AthleteMaxes athleteId={id} unit={unitOf(athlete.unit)} />}</SlideIn>
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
          onImported={() => { if (id) void loadPrograms(id) }}
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
