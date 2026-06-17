// API contract types shared between client and server.
// Server DB types (AthleteTable, ProgramTable, etc.) are internal to the server;
// these represent what the API actually sends over the wire.

export interface Athlete {
  id: string
  name: string
  email: string | null
  sport: string | null
  date_of_birth: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface Exercise {
  id: string
  workout_id: string
  name: string
  sets: string | null
  reps: string | null
  weight: number | null
  duration: number | null
  distance: number | null
  notes: string | null
  order_index: number
  rest_time: string | null
  intensity: string | null
  load_used: string | null
  rpe: string | null
  group_id: string | null
  suggestion_note: string | null
}

export interface Workout {
  id: string
  program_id: string
  name: string
  scheduled_date: string | null
  completed_at: string | null
  notes: string | null
  created_at: string
  exercises: Exercise[]
}

export type ToggleableColumn = 'rest_time' | 'intensity' | 'load_cap' | 'load_used' | 'rpe'
export const TOGGLEABLE_COLUMNS: ToggleableColumn[] = ['rest_time', 'intensity', 'load_cap', 'load_used', 'rpe']

export interface Program {
  id: string
  athlete_id: string
  name: string
  description: string | null
  start_date: string | null
  end_date: string | null
  status: string
  created_at: string
  updated_at: string
  enabled_columns: ToggleableColumn[] | null
  workouts?: Workout[]
}

export interface ProgressRecord {
  id: string
  athlete_id: string
  metric_name: string
  value: number
  unit: string | null
  recorded_at: string
  notes: string | null
}

export interface AthleteMax {
  id: string
  athlete_id: string
  lift_name: string
  weight: number
  unit: string
  recorded_at: string
  notes: string | null
}

// ---------------------------------------------------------------------------
// Excel import types
// ---------------------------------------------------------------------------

export interface ImportMatch {
  exerciseId: string
  exerciseName: string      // from DB
  sheetName: string | null  // read from Excel cell (sanity check)
  weekIndex: number         // 0-based
  dayOfWeek: number         // 0-based (0 = Monday)
  rowIndex: number          // 0-based within this day+week
  load_used: string | null  // parsed from "Load Used" column
  rpe: string | null        // parsed from "Last Set RPE" column
  nameMismatch: boolean     // sheet name didn't match the DB exercise name
}

export interface ImportWarning {
  weekIndex?: number
  dayOfWeek?: number
  rowIndex?: number
  message: string
}

export interface E1RMEstimate {
  liftName: string   // exercise name as stored in DB
  e1rm: number       // kg, rounded to 1 decimal
  weight: number     // load used (kg)
  reps: number       // reps prescribed
  rpe: number        // reported RPE
  weekIndex: number  // 0-based (will be the last week of the program)
}

export interface ImportPreview {
  matched: ImportMatch[]
  warnings: ImportWarning[]
  e1rmEstimates: E1RMEstimate[]
}

// ---------------------------------------------------------------------------
// Program analysis / report types (Phase 3)
// ---------------------------------------------------------------------------

export interface E1RMDataPoint {
  weekIndex: number
  e1rm: number
  weight: number
  reps: number
  rpe: number
  exerciseName: string
}

export interface LiftE1RMTrend {
  liftKey: string
  displayName: string
  dataPoints: E1RMDataPoint[]
  latestE1RM: number | null
  bestE1RM: number | null
}

export interface RPEDeviationRow {
  exerciseName: string
  weekIndex: number
  dayOfWeek: number
  prescribedRpe: number | null
  reportedRpe: number | null
  delta: number | null
}

export interface ProgramReport {
  programId: string
  athleteId: string
  e1rmTrends: LiftE1RMTrend[]
  rpeDeviations: RPEDeviationRow[]
  avgRpeDeviation: number | null
  completionRate: number
  exercisesTotal: number
  exercisesCompleted: number
  storedMaxes: AthleteMax[]
}

// ---------------------------------------------------------------------------
// Suggestion engine types (Feature 3b)
// ---------------------------------------------------------------------------

export type SuggestionGoal = 'hypertrophy' | 'strength' | 'peaking'

export interface WeekSlot {
  week: number         // 1-based
  sets: number
  reps: number
  targetRpe: number
  weight: number       // kg, rounded to 2.5
  explanation: string  // tooltip text shown in the calendar editor
}

export interface SuggestionTemplateInfo {
  id: string
  goal: SuggestionGoal
  variant: string
  label: string
  typicalWeeks: [number, number]  // [min, max] — shown as a hint in the wizard
}

// Metadata for all six templates — shared so the client wizard can render
// pickers without importing server-only generate functions.
export const SUGGESTION_TEMPLATES: SuggestionTemplateInfo[] = [
  {
    id: 'hypertrophy_accumulation',
    goal: 'hypertrophy',
    variant: 'accumulation',
    label: 'Accumulation',
    typicalWeeks: [4, 6],
  },
  {
    id: 'hypertrophy_repeated_effort',
    goal: 'hypertrophy',
    variant: 'repeated_effort',
    label: 'Repeated Effort',
    typicalWeeks: [4, 4],
  },
  {
    id: 'strength_linear',
    goal: 'strength',
    variant: 'linear',
    label: 'Linear Intensification',
    typicalWeeks: [4, 6],
  },
  {
    id: 'strength_wave',
    goal: 'strength',
    variant: 'wave',
    label: 'Wave Loading',
    typicalWeeks: [6, 9],
  },
  {
    id: 'peaking_standard',
    goal: 'peaking',
    variant: 'standard',
    label: 'Standard Peak',
    typicalWeeks: [3, 4],
  },
  {
    id: 'peaking_extended',
    goal: 'peaking',
    variant: 'extended',
    label: 'Extended Peak',
    typicalWeeks: [5, 6],
  },
]

export interface SuggestProgramBody {
  athleteId: string
  templateId: string
  weeks: number
  trainingDaysPerWeek: number  // 3–5, chosen in the wizard
  startDate: string            // ISO date — first day of new block
}

export interface SuggestProgramResult {
  draftProgramId: string
}

// ---------------------------------------------------------------------------
// Request body shapes — mirrors what routes accept
// ---------------------------------------------------------------------------
export interface CreateAthleteBody {
  name: string
  email?: string | null
  sport?: string | null
  date_of_birth?: string | null
  notes?: string | null
}

export interface CreateProgramBody {
  athlete_id: string
  name: string
  description?: string | null
  start_date?: string | null
  end_date?: string | null
  status?: string
  enabled_columns?: ToggleableColumn[] | null
}

export interface UpdateProgramBody {
  name?: string
  description?: string | null
  start_date?: string | null
  end_date?: string | null
  status?: string
  enabled_columns?: ToggleableColumn[] | null
}

export interface CreateProgressBody {
  athlete_id: string
  metric_name: string
  value: number
  unit?: string | null
  recorded_at?: string
  notes?: string | null
}
