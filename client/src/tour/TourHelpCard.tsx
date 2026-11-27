import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Compass, ListChecks, UserMinus, UserPlus } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Button } from '../components/ui/button'
import { useToast } from '../components/ui/toast'
import { useConfirm } from '../components/ui/confirm-dialog'
import { errorMessage } from '../lib/api'
import { useTour } from './TourProvider'
import { TOUR_STOPS } from './stops'
import { getSample, getTourStatus, loadSample, removeSample, saveTour, type TourStatus } from './tourApi'

// Settings → Help (T5, D20): take the tour again, load or remove the sample
// athlete, and bring back the setup checklist.

export default function TourHelpCard() {
  const tour = useTour()
  const toast = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const [status, setStatus] = useState<TourStatus | null>(null)
  const [sample, setSample] = useState<{ loaded: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getTourStatus().then(setStatus, () => setStatus(null))
    getSample().then(setSample, () => setSample(null))
  }, [])

  const resumeAt = status?.tourAt != null && status.tourAt > 0 && status.tourAt < TOUR_STOPS.length - 1 ? status.tourAt : null

  const toggleSample = async () => {
    if (sample?.loaded) {
      const ok = await confirm({
        title: 'Remove Sample Athlete?',
        description: 'Its programs, maxes, payment and anything you changed on it go too. Your own athletes are not touched, and you can load it again here.',
        confirmLabel: 'Remove',
        destructive: true,
      })
      if (!ok) return
    }
    setBusy(true)
    try {
      setSample(sample?.loaded ? await removeSample() : await loadSample())
      toast.success(sample?.loaded ? 'Sample Athlete removed.' : 'Sample Athlete loaded — find it under Athletes.')
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const showChecklist = async () => {
    try {
      await saveTour({ checklist: { done: false } })
      navigate('/')
    } catch (err) {
      toast.error(errorMessage(err))
    }
  }

  return (
    <Card data-tour="help">
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Compass className="h-4 w-4 text-primary" />Getting started</CardTitle>
        <CardDescription>
          A guided walk through every part of CoachBoard, on Sample Athlete — a made-up lifter, so
          nothing of yours is touched.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button onClick={() => tour.start(0)}>
          <Compass className="h-4 w-4" />{status?.tourFinished || resumeAt === null ? 'Take the tour' : 'Take the tour from the start'}
        </Button>
        {resumeAt !== null && (
          <Button variant="outline" onClick={() => tour.start(resumeAt)}>Carry on from stop {resumeAt + 1}</Button>
        )}
        <Button variant="outline" onClick={toggleSample} disabled={busy || sample === null}>
          {sample?.loaded ? <><UserMinus className="h-4 w-4" />Remove Sample Athlete</> : <><UserPlus className="h-4 w-4" />Load Sample Athlete</>}
        </Button>
        <Button variant="outline" onClick={showChecklist}>
          <ListChecks className="h-4 w-4" />Show the setup checklist
        </Button>
      </CardContent>
    </Card>
  )
}
