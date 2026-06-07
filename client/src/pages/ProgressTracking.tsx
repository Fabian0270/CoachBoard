import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { TrendingUp, Plus, Trash2 } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

interface Athlete { id: string; name: string }
interface Record { id: string; athlete_id: string; metric_name: string; value: number; unit: string | null; recorded_at: string }

export default function ProgressTracking() {
  const [athletes, setAthletes] = useState<Athlete[]>([])
  const [records, setRecords] = useState<Record[]>([])
  const [selectedAthlete, setSelectedAthlete] = useState<string>('')
  const [form, setForm] = useState({ metric_name: '', value: '', unit: '', recorded_at: new Date().toISOString().split('T')[0] })

  useEffect(() => {
    fetch('/api/athletes')
      .then((r) => r.json())
      .then((data) => {
        const list = Array.isArray(data) ? data : []
        setAthletes(list)
        if (list.length) setSelectedAthlete(list[0].id)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!selectedAthlete) return
    fetch(`/api/progress?athlete_id=${selectedAthlete}`)
      .then((r) => r.json())
      .then((data) => setRecords(Array.isArray(data) ? data : []))
      .catch(() => {})
  }, [selectedAthlete])

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    const res = await fetch('/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, athlete_id: selectedAthlete, value: Number(form.value) }),
    })
    const record = await res.json()
    setRecords([record, ...records])
    setForm({ metric_name: '', value: '', unit: '', recorded_at: new Date().toISOString().split('T')[0] })
  }

  const handleDelete = async (id: string) => {
    await fetch(`/api/progress/${id}`, { method: 'DELETE' })
    setRecords(records.filter((r) => r.id !== id))
  }

  const metrics = [...new Set(records.map((r) => r.metric_name))]
  const chartData = records.slice().reverse().map((r) => ({ date: r.recorded_at.split('T')[0], value: r.value, metric: r.metric_name }))

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Progress Tracking</h1>
      {athletes.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground">No athletes found. Add athletes first.</CardContent></Card>
      ) : (
        <>
          <Select value={selectedAthlete} onValueChange={setSelectedAthlete}>
            <SelectTrigger className="w-48"><SelectValue placeholder="Select athlete" /></SelectTrigger>
            <SelectContent>{athletes.map((a) => <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}</SelectContent>
          </Select>
          <Card>
            <CardHeader><CardTitle>Log Performance</CardTitle></CardHeader>
            <CardContent>
              <form onSubmit={handleAdd} className="flex flex-wrap gap-3 items-end">
                <div className="space-y-1"><Label>Metric</Label><Input required value={form.metric_name} onChange={(e) => setForm({ ...form, metric_name: e.target.value })} placeholder="e.g. 100m sprint" /></div>
                <div className="space-y-1"><Label>Value</Label><Input required type="number" step="any" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder="0" /></div>
                <div className="space-y-1"><Label>Unit</Label><Input value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} placeholder="s, kg, m..." /></div>
                <div className="space-y-1"><Label>Date</Label><Input type="date" value={form.recorded_at} onChange={(e) => setForm({ ...form, recorded_at: e.target.value })} /></div>
                <Button type="submit"><Plus className="h-4 w-4 mr-1" />Add</Button>
              </form>
            </CardContent>
          </Card>
          {metrics.length > 0 && (
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2"><TrendingUp className="h-5 w-5" />Performance Chart</CardTitle></CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip />
                    {metrics.map((m, i) => (
                      <Line key={m} type="monotone" dataKey="value" data={chartData.filter((d) => d.metric === m)} name={m} stroke={`hsl(${i * 60}, 70%, 50%)`} strokeWidth={2} dot={false} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}
          <div className="space-y-2">
            {records.length === 0 ? (
              <Card><CardContent className="py-6 text-center text-muted-foreground">No records yet.</CardContent></Card>
            ) : records.map((r) => (
              <Card key={r.id}>
                <CardContent className="flex items-center justify-between py-3">
                  <div>
                    <span className="font-medium">{r.metric_name}</span>
                    <span className="ml-2 text-primary font-semibold">{r.value}{r.unit ? ` ${r.unit}` : ''}</span>
                    <span className="ml-2 text-sm text-muted-foreground">{r.recorded_at.split('T')[0]}</span>
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(r.id)}><Trash2 className="h-4 w-4" /></Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
