import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { CopyPlus, FileUp, Plus, Search, Sparkles, Star, ArrowLeft } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Button } from './ui/button'
import LoadError from './LoadError'
import DuplicateProgramDialog from './DuplicateProgramDialog'
import { errorMessage, getList } from '../lib/api'
import { matchesSearch } from '../lib/search'

interface ProgramRow {
  id: string
  name: string
  status: string
  athlete_id: string | null
  start_date: string | null
  bookmarked?: number
}

/**
 * Every way to start a program, in one place: blank, a copy of an existing
 * program or template, the next block generated from a finished one, or an
 * Excel file. These used to be spread over two drop-downs and a separate
 * button, and differed between the Programs page and an athlete's page.
 */
export default function NewProgramChooser({
  open,
  onOpenChange,
  athleteId,
  onGenerate,
  onImport,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Set on an athlete's page: the new program is for them. */
  athleteId?: string
  onGenerate: () => void
  onImport: () => void
}) {
  const navigate = useNavigate()
  const [step, setStep] = useState<'choose' | 'pick'>('choose')
  const [programs, setPrograms] = useState<ProgramRow[] | null>(null)
  const [athletes, setAthletes] = useState<Map<string, string>>(new Map())
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<ProgramRow | null>(null)

  useEffect(() => { if (open) { setStep('choose'); setQuery('') } }, [open])

  const loadPrograms = () => {
    setLoadError(null)
    Promise.all([getList<ProgramRow>('/api/programs'), getList<{ id: string; name: string }>('/api/athletes?include_archived=1')])
      .then(([p, a]) => { setPrograms(p); setAthletes(new Map(a.map((x) => [x.id, x.name]))) })
      .catch((err) => setLoadError(errorMessage(err)))
  }
  useEffect(() => { if (open && step === 'pick') loadPrograms() }, [open, step])

  // Templates and bookmarked programs first — they exist to be reused — then
  // this athlete's own, then the most recent.
  const sorted = useMemo(() => {
    const rank = (p: ProgramRow) =>
      (p.athlete_id === null ? 0 : 2) + (p.bookmarked === 1 ? 0 : 1) + (athleteId && p.athlete_id === athleteId ? 0 : 0.5)
    return (programs ?? [])
      .filter((p) => matchesSearch(query, [p.name, p.athlete_id ? athletes.get(p.athlete_id) : 'template']))
      .sort((a, b) => rank(a) - rank(b) || (b.start_date ?? '').localeCompare(a.start_date ?? ''))
  }, [programs, athletes, query, athleteId])

  const option = (icon: typeof Plus, title: string, body: string, onClick: () => void) => {
    const Icon = icon
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent focus:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <span>
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-xs text-muted-foreground">{body}</span>
        </span>
      </button>
    )
  }

  return (
    <>
      <Dialog open={open && !source} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          {step === 'choose' ? (
            <>
              <DialogHeader>
                <DialogTitle>New program</DialogTitle>
                <DialogDescription>How do you want to start?</DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                {option(Plus, 'Blank', 'An empty calendar to fill in yourself.', () => {
                  onOpenChange(false)
                  navigate(athleteId ? `/programs/new?athlete_id=${athleteId}` : '/programs/new')
                })}
                {option(CopyPlus, 'From an existing program or template', 'A copy of a block you have already written, with its loads scaled if you like.', () => setStep('pick'))}
                {option(Sparkles, 'Generate the next block', 'From a finished program and how the athlete did, in your style.', () => {
                  onOpenChange(false)
                  onGenerate()
                })}
                {option(FileUp, 'Import from Excel', 'A program you already have in a spreadsheet — or a whole folder of them.', () => {
                  onOpenChange(false)
                  onImport()
                })}
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Start from…</DialogTitle>
                <DialogDescription>Templates and bookmarked programs are first.</DialogDescription>
              </DialogHeader>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  type="search" value={query} onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search programs or athletes" aria-label="Search programs" className="pl-8"
                />
              </div>
              <div className="max-h-[50vh] space-y-1 overflow-y-auto">
                {loadError ? (
                  <LoadError what="your programs" message={loadError} onRetry={loadPrograms} />
                ) : programs === null ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                ) : sorted.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{query ? 'No programs match.' : 'There are no programs to copy yet.'}</p>
                ) : (
                  sorted.map((p) => (
                    <button
                      key={p.id} type="button" onClick={() => setSource(p)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none"
                    >
                      {p.bookmarked === 1 && <Star className="h-3.5 w-3.5 shrink-0 fill-warning text-warning" aria-label="Bookmarked" />}
                      <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {p.athlete_id ? athletes.get(p.athlete_id) ?? '' : 'Template'}
                      </span>
                    </button>
                  ))
                )}
              </div>
              <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setStep('choose')}>
                <ArrowLeft className="h-4 w-4" />Back
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
      <DuplicateProgramDialog
        program={source}
        open={source !== null}
        defaultAthleteId={athleteId}
        onOpenChange={(o) => { if (!o) { setSource(null); onOpenChange(false) } }}
      />
    </>
  )
}
