import { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { ArrowLeft, Trash2, Dumbbell } from 'lucide-react'

interface Exercise {
  id: string
  name: string
  sets: number | null
  reps: number | null
  weight: number | null
  duration: number | null
  distance: number | null
  notes: string | null
}

interface Workout {
  id: string
  name: string
  scheduled_date: string | null
  completed_at: string | null
  exercises: Exercise[]
}

interface Program {
  id: string
  name: string
  description: string | null
  status: string
  start_date: string | null
  end_date: string | null
  workouts: Workout[]
}

export default function ProgramDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [program, setProgram] = useState<Program | null>(null)

  useEffect(() => {
    if (!id) return
    fetch(`/api/programs/${id}`).then((r) => r.json()).then(setProgram)
  }, [id])

  const handleDelete = async () => {
    if (!confirm('Delete this program?')) return
    await fetch(`/api/programs/${id}`, { method: 'DELETE' })
    navigate('/programs')
  }

  if (!program) return <div className="text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/programs"><ArrowLeft className="h-5 w-5 text-muted-foreground" /></Link>
          <h1 className="text-3xl font-bold">{program.name}</h1>
          <Badge variant={program.status === 'active' ? 'default' : 'secondary'}>{program.status}</Badge>
        </div>
        <Button variant="destructive" size="sm" onClick={handleDelete}><Trash2 className="h-4 w-4" /></Button>
      </div>
      {program.description && <p className="text-muted-foreground">{program.description}</p>}
      {(program.start_date || program.end_date) && (
        <div className="text-sm text-muted-foreground">
          {program.start_date} {program.end_date ? `→ ${program.end_date}` : ''}
        </div>
      )}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Workouts ({program.workouts.length})</h2>
        {program.workouts.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <Dumbbell className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">No workouts in this program yet.</p>
            </CardContent>
          </Card>
        ) : program.workouts.map((w) => (
          <Card key={w.id}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{w.name}</CardTitle>
              {w.scheduled_date && <div className="text-sm text-muted-foreground">{w.scheduled_date}</div>}
            </CardHeader>
            <CardContent>
              {w.exercises.length === 0 ? (
                <p className="text-sm text-muted-foreground">No exercises.</p>
              ) : (
                <ul className="space-y-1">
                  {w.exercises.map((ex) => (
                    <li key={ex.id} className="text-sm flex gap-2">
                      <span className="font-medium">{ex.name}</span>
                      {ex.sets && <span>{ex.sets}×{ex.reps ?? '?'}</span>}
                      {ex.weight && <span>{ex.weight}kg</span>}
                      {ex.duration && <span>{ex.duration}s</span>}
                      {ex.distance && <span>{ex.distance}m</span>}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
