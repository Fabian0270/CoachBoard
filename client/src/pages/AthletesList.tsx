import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardContent } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import DeleteAthleteDialog from '../components/DeleteAthleteDialog'
import { Plus, Users, Trash2 } from 'lucide-react'

interface Athlete {
  id: string
  name: string
  sport: string | null
  email: string | null
  archived: number
}

export default function AthletesList() {
  const [athletes, setAthletes] = useState<Athlete[]>([])
  const [loading, setLoading] = useState(true)
  const [toDelete, setToDelete] = useState<Athlete | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  useEffect(() => {
    // Fetch archived too so the roster can offer a "show archived" toggle without a refetch.
    fetch('/api/athletes?include_archived=1')
      .then((r) => r.json())
      .then((data) => { setAthletes(Array.isArray(data) ? data : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const handleDelete = (e: React.MouseEvent, athlete: Athlete) => {
    e.preventDefault()
    e.stopPropagation()
    setToDelete(athlete)
  }

  if (loading) return <div className="text-muted-foreground">Loading...</div>

  const active = athletes.filter((a) => !a.archived)
  const archived = athletes.filter((a) => a.archived)

  const renderCard = (athlete: Athlete) => (
    <div key={athlete.id} className="relative group">
      <Link to={`/athletes/${athlete.id}`}>
        <Card className="hover:shadow-md transition-shadow cursor-pointer">
          <CardContent className="p-4 pr-12">
            <div className="font-semibold text-lg flex items-center gap-2">
              {athlete.name}
              {athlete.archived ? <Badge variant="outline" className="text-xs font-normal">Archived</Badge> : null}
            </div>
            {athlete.sport && <Badge variant="secondary" className="mt-1">{athlete.sport}</Badge>}
            {athlete.email && <div className="text-sm text-muted-foreground mt-2">{athlete.email}</div>}
          </CardContent>
        </Card>
      </Link>
      <button
        type="button"
        onClick={(e) => handleDelete(e, athlete)}
        aria-label={`Delete ${athlete.name}`}
        className="absolute top-2 right-2 p-2 rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-destructive transition-opacity disabled:opacity-50"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Athletes</h1>
        <Link to="/athletes/new"><Button><Plus className="h-4 w-4 mr-2" />New Athlete</Button></Link>
      </div>
      {active.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Users className="h-12 w-12 text-muted-foreground mb-4" />
            <h2 className="text-lg font-semibold mb-2">No athletes yet</h2>
            <p className="text-muted-foreground mb-4">Add your first athlete to get started.</p>
            <Link to="/athletes/new"><Button>Add Athlete</Button></Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {active.map(renderCard)}
        </div>
      )}

      {archived.length > 0 && (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {showArchived ? 'Hide' : 'Show'} archived athletes ({archived.length})
          </button>
          {showArchived && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {archived.map(renderCard)}
            </div>
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
