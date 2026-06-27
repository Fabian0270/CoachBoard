import type { ExternalImportPreview, SuggestionGoal } from 'coachboard-shared'

export interface Athlete { id: string; name: string; archived: number }

export interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (programId: string) => void   // single import → open the new program
  onImported: () => void                    // bulk import → refresh the list
}

export type Step = 'pick' | 'parsing' | 'single' | 'bulk' | 'committing' | 'done'

// One uploaded file, after its dry-run parse.
export interface Entry {
  key: string
  file: File
  fileName: string
  groupKey: string          // lowercased athlete name, '' = unassigned
  groupLabel: string        // display name for the group
  programName: string       // editable
  focus: SuggestionGoal | ''
  include: boolean
  preview: ExternalImportPreview | null
  error: string | null      // parse/network error
}

// How a detected athlete-group maps onto a real athlete (bulk mode).
export interface Assignment {
  mode: 'new' | 'existing'
  existingId: string
  newName: string
}

export interface CommitSummary {
  imported: number
  athletes: number
  skipped: number
  failed: Array<{ name: string; error: string }>
}
