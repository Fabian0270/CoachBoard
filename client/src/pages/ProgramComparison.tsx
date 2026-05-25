import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Plus, Dumbbell } from 'lucide-react'

interface Athlete { id: string; name: string }
interface Program { id: string; name: string; status: string; athlete_id: string; start_date: string | null }

export default function ProgramComparison() {
  const [athletes, setAthletes] = useState<Athlete[]>([])
  const [programs, setPrograms] = useState<Program[]>([])
  const [selectedAthlete, setSelectedAthlete] = useState<string>('all')

  useEffect(() => {
    Promise.all([
      fetch('/api/athletes').then((r) => r.json()),
      fetch('/api/programs').then((r) => r.json()),
    ]).then(([a, p]) => { setAthletes(a); setPrograms(p) })
  }, [])

  const filtered = selectedAthlete === 'all' ? programs : programs.filter((p) => p.athlete_id === selectedAthlete)
  const athleteMap = Object.fromEntries(athletes.map((a) => [a.id, a.name]))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Programs</h1>
        <Link to="/programs/new"><Button><Plus className="h-4 w-4 mr-2" />New Program</Button></Link>
      </div>
      {athletes.length > 0 && (
        <Select value={selectedAthlete} onValueChange={setSelectedAthlete}>
          <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Athletes</SelectItem>
            {athletes.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
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
          {filtered.map((p) => (
            <Link key={p.id} to={`/programs/${p.id}`}>
              <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
                <CardHeader>
                  <CardTitle className="text-base">{p.name}</CardTitle>
                  <div className="text-sm text-muted-foreground">{athleteMap[p.athlete_id] ?? 'Unknown'}</div>
                </CardHeader>
                <CardContent>
                  <Badge variant={p.status === 'active' ? 'default' : 'secondary'}>{p.status}</Badge>
                  {p.start_date && <div className="text-sm text-muted-foreground mt-2">Started: {p.start_date}</div>}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
