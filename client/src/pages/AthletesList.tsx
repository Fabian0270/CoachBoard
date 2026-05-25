import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardContent } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Plus, Users } from 'lucide-react'

interface Athlete {
  id: string
  name: string
  sport: string | null
  email: string | null
}

export default function AthletesList() {
  const [athletes, setAthletes] = useState<Athlete[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/athletes')
      .then((r) => r.json())
      .then((data) => { setAthletes(data); setLoading(false) })
  }, [])

  if (loading) return <div className="text-muted-foreground">Loading...</div>

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Athletes</h1>
        <Link to="/athletes/new"><Button><Plus className="h-4 w-4 mr-2" />New Athlete</Button></Link>
      </div>
      {athletes.length === 0 ? (
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
          {athletes.map((athlete) => (
            <Link key={athlete.id} to={`/athletes/${athlete.id}`}>
              <Card className="hover:shadow-md transition-shadow cursor-pointer">
                <CardContent className="p-4">
                  <div className="font-semibold text-lg">{athlete.name}</div>
                  {athlete.sport && <Badge variant="secondary" className="mt-1">{athlete.sport}</Badge>}
                  {athlete.email && <div className="text-sm text-muted-foreground mt-2">{athlete.email}</div>}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
