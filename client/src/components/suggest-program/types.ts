export interface SelectableAthlete { id: string; name: string }
export interface SelectableProgram { id: string; name: string; status: string; start_date: string | null }

export interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  programId?: string
  athleteId?: string
  onCreated: (draftProgramId: string) => void
}

export type Step = 'athlete' | 'source' | 'goal' | 'variant' | 'days' | 'options'
