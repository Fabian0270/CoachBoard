import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { Sparkles } from 'lucide-react'
import type { CoachStyleProfile } from 'coachboard-shared'

const VOLUME_PHRASE: Record<string, string> = {
  rising: 'Volume usually ramps up across the block',
  flat: 'Volume usually stays flat across the block',
  tapering: 'Volume usually tapers into the final week',
}
const INTENSITY_PHRASE: Record<string, string> = {
  rising: 'Intensity rises steadily across the block',
  flat: 'Intensity stays fairly flat across the block',
  wave: 'Intensity moves in waves across the block',
}

export default function MyStyleCard() {
  const [profile, setProfile] = useState<CoachStyleProfile | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/style-profile')
      .then((r) => r.json())
      .then((data) => setProfile(data as CoachStyleProfile))
      .catch(() => setProfile(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading || !profile) return null

  const bullets: string[] = []
  if (profile.usable) {
    if (profile.preferredBlockWeeks && profile.preferredDaysPerWeek) {
      bullets.push(`You typically run ${profile.preferredBlockWeeks}-week blocks, ${profile.preferredDaysPerWeek} days per week`)
    }
    if (profile.preferredRepRange) bullets.push(`Dominant rep range: ${profile.preferredRepRange} reps`)
    if (profile.typicalStartRpe !== null && profile.typicalPeakRpe !== null) {
      bullets.push(`You start blocks around RPE ${profile.typicalStartRpe} and peak around RPE ${profile.typicalPeakRpe}`)
    }
    if (profile.volumePattern) bullets.push(VOLUME_PHRASE[profile.volumePattern])
    if (profile.intensityPattern) bullets.push(INTENSITY_PHRASE[profile.intensityPattern])
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-1.5">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          My Style
        </CardTitle>
      </CardHeader>
      <CardContent>
        {profile.usable ? (
          <>
            <p className="text-sm text-muted-foreground mb-2">
              Based on {profile.sampleSize} completed program{profile.sampleSize !== 1 ? 's' : ''}:
            </p>
            <ul className="text-sm space-y-1 list-disc list-inside">
              {bullets.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {profile.sampleSize === 0
              ? 'No completed programs yet. '
              : `Only ${profile.sampleSize} completed program${profile.sampleSize !== 1 ? 's' : ''} so far. `}
            Import or complete more programs to personalise your suggestions.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
