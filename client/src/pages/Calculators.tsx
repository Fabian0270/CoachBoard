import { useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs'
import { Calculator, Flame } from 'lucide-react'
import type { Sex, Equipment, MeetEvent } from 'coachboard-shared/scoring'
import { allScores } from 'coachboard-shared/scoring'
import { warmupPlan, platesPerSide } from 'coachboard-shared/warmup'

function num(value: string): number {
  // Accept Swedish comma decimals like the rest of the app.
  return Number(value.replace(',', '.'))
}

function fmtScore(value: number | null): string {
  return value == null ? '—' : value.toFixed(2)
}

function ScoringCalculator() {
  const [sex, setSex] = useState<Sex>('male')
  const [equipment, setEquipment] = useState<Equipment>('classic')
  const [event, setEvent] = useState<MeetEvent>('full')
  const [bodyweight, setBodyweight] = useState('')
  const [total, setTotal] = useState('')

  const scores = useMemo(
    () => allScores({ total: num(total), bodyweight: num(bodyweight), sex, equipment, event }),
    [total, bodyweight, sex, equipment, event],
  )

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Lifter & total</CardTitle></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1">
            <Label>Sex</Label>
            <Select value={sex} onValueChange={(v) => setSex(v as Sex)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="male">Male</SelectItem>
                <SelectItem value="female">Female</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Equipment</Label>
            <Select value={equipment} onValueChange={(v) => setEquipment(v as Equipment)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="classic">Classic (raw)</SelectItem>
                <SelectItem value="equipped">Equipped</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Event</Label>
            <Select value={event} onValueChange={(v) => setEvent(v as MeetEvent)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="full">Full (SBD)</SelectItem>
                <SelectItem value="bench">Bench only</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Bodyweight (kg)</Label>
            <Input type="text" inputMode="decimal" value={bodyweight} onChange={(e) => setBodyweight(e.target.value)} placeholder="e.g. 82.5" />
          </div>
          <div className="space-y-1">
            <Label>Total (kg)</Label>
            <Input type="text" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="e.g. 600" />
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">IPF GL Points</CardTitle></CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-primary">{fmtScore(scores.ipfGl)}</div>
            <p className="text-xs text-muted-foreground mt-1">Official IPF formula (equipment + event aware)</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">DOTS</CardTitle></CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-primary">{fmtScore(scores.dots)}</div>
            <p className="text-xs text-muted-foreground mt-1">Sex &amp; bodyweight only</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Wilks</CardTitle></CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-primary">{fmtScore(scores.wilks)}</div>
            <p className="text-xs text-muted-foreground mt-1">Original Wilks formula</p>
          </CardContent>
        </Card>
      </div>
      <p className="text-xs text-muted-foreground">
        Equipment and event affect the IPF GL Points only; DOTS and Wilks depend on sex, bodyweight and total.
      </p>
    </div>
  )
}

function WarmupCalculator() {
  const [oneRM, setOneRM] = useState('')
  const [bar, setBar] = useState('20')
  const [rounding, setRounding] = useState('2.5')

  const sets = useMemo(
    () => warmupPlan(num(oneRM), { barWeight: num(bar) || 20, rounding: num(rounding) || 2.5 }),
    [oneRM, bar, rounding],
  )
  const barWeight = num(bar) || 20

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Target</CardTitle></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <Label>Target 1RM (kg)</Label>
            <Input type="text" inputMode="decimal" value={oneRM} onChange={(e) => setOneRM(e.target.value)} placeholder="e.g. 200" />
          </div>
          <div className="space-y-1">
            <Label>Bar weight (kg)</Label>
            <Input type="text" inputMode="decimal" value={bar} onChange={(e) => setBar(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Round to (kg)</Label>
            <Input type="text" inputMode="decimal" value={rounding} onChange={(e) => setRounding(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      {sets.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Warm-up sets</CardTitle></CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Set</th>
                  <th className="px-4 py-2 font-medium">%</th>
                  <th className="px-4 py-2 font-medium">Weight</th>
                  <th className="px-4 py-2 font-medium">Reps</th>
                  <th className="px-4 py-2 font-medium">Plates/side</th>
                  <th className="px-4 py-2 font-medium">Rest</th>
                </tr>
              </thead>
              <tbody>
                {sets.map((set, i) => {
                  const plates = platesPerSide(set.weight, barWeight)
                  return (
                    <tr key={i} className={set.isMax ? 'border-b bg-accent/40 font-semibold' : 'border-b'}>
                      <td className="px-4 py-2">{set.isMax ? 'Max' : i + 1}</td>
                      <td className="px-4 py-2">{set.pct}%</td>
                      <td className="px-4 py-2">{set.weight} kg</td>
                      <td className="px-4 py-2">{set.reps}</td>
                      <td className="px-4 py-2 text-muted-foreground">{plates.length ? plates.join(' + ') : '—'}</td>
                      <td className="px-4 py-2 text-muted-foreground">{set.restMinutes == null ? '—' : `${set.restMinutes} min`}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
      <p className="text-xs text-muted-foreground">
        Protocol from StrengthLog's 1RM-attempt warm-up: seven ramping sets into the top single.
      </p>
    </div>
  )
}

export default function Calculators() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Calculators</h1>
      <Tabs defaultValue="scoring">
        <TabsList>
          <TabsTrigger value="scoring"><Calculator className="h-4 w-4 mr-2" />Scoring</TabsTrigger>
          <TabsTrigger value="warmup"><Flame className="h-4 w-4 mr-2" />Warm-up</TabsTrigger>
        </TabsList>
        <TabsContent value="scoring"><ScoringCalculator /></TabsContent>
        <TabsContent value="warmup"><WarmupCalculator /></TabsContent>
      </Tabs>
    </div>
  )
}
