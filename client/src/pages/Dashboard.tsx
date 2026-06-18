import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Users, Dumbbell, TrendingUp, Plus } from 'lucide-react'
import MyStyleCard from '../components/MyStyleCard'

interface Stats {
  athletes: number
  programs: number
  progressRecords: number
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats>({ athletes: 0, programs: 0, progressRecords: 0 })

  useEffect(() => {
    Promise.all([
      fetch('/api/athletes').then((r) => r.json()).catch(() => []),
      fetch('/api/programs').then((r) => r.json()).catch(() => []),
      fetch('/api/progress').then((r) => r.json()).catch(() => []),
    ]).then(([athletes, programs, progress]) => {
      setStats({
        athletes: Array.isArray(athletes) ? athletes.length : 0,
        programs: Array.isArray(programs) ? programs.length : 0,
        progressRecords: Array.isArray(progress) ? progress.length : 0,
      })
    }).catch(() => {})
  }, [])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Dashboard</h1>
        <Link to="/athletes/new">
          <Button><Plus className="h-4 w-4 mr-2" />Add Athlete</Button>
        </Link>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total Athletes</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.athletes}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Training Programs</CardTitle>
            <Dumbbell className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.programs}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Progress Records</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.progressRecords}</div>
          </CardContent>
        </Card>
      </div>
      <MyStyleCard />
      {stats.athletes === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Users className="h-12 w-12 text-muted-foreground mb-4" />
            <h2 className="text-lg font-semibold mb-2">No athletes yet</h2>
            <p className="text-muted-foreground mb-4">Get started by adding your first athlete.</p>
            <Link to="/athletes/new"><Button>Add your first athlete</Button></Link>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
