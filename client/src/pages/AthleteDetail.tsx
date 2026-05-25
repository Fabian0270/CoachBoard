import { useEffect, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Plus, ArrowLeft, Trash2 } from 'lucide-react'

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
}

export default function AthleteDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [athlete, setAthlete] = useState<Athlete | null>(null)
  const [programs, setPrograms] = useState<Program[]>([])

  useEffect(() => {
    if (!id) return
    Promise.all([
      fetch(`/api/athletes/${id}`).then((r) => r.json()),
      fetch(`/api/programs?athlete_id=${id}`).then((r) => r.json()),
    ]).then(([a, p]) => { setAthlete(a); setPrograms(p) })
  }, [id])

  const handleDelete = async () => {
    if (!confirm('Delete this athlete?')) return
    await fetch(`/api/athletes/${id}`, { method: 'DELETE' })
    navigate('/athletes')
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
        </TabsList>
        <TabsContent value="info">
          <Card>
            <CardContent className="p-6 space-y-3">
              {athlete.email && <div><span className="font-medium">Email:</span> {athlete.email}</div>}
              {athlete.date_of_birth && <div><span className="font-medium">Date of Birth:</span> {athlete.date_of_birth}</div>}
              {athlete.notes && <div><span className="font-medium">Notes:</span> {athlete.notes}</div>}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="programs">
          <div className="space-y-3">
            <Link to={`/programs/new?athlete_id=${id}`}><Button size="sm"><Plus className="h-4 w-4 mr-2" />New Program</Button></Link>
            {programs.length === 0 ? (
              <Card><CardContent className="py-8 text-center text-muted-foreground">No programs yet.</CardContent></Card>
            ) : programs.map((p) => (
              <Link key={p.id} to={`/programs/${p.id}`}>
                <Card className="hover:shadow-md transition-shadow cursor-pointer">
                  <CardHeader className="py-4">
                    <CardTitle className="text-base">{p.name}</CardTitle>
                    <Badge variant={p.status === 'active' ? 'default' : 'secondary'}>{p.status}</Badge>
                  </CardHeader>
                </Card>
              </Link>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
