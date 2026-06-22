// API contract types shared between client and server.
// Server DB types (AthleteTable, ProgramTable, etc.) are internal to the server;
// these represent what the API actually sends over the wire.

import type { ExportLayoutTemplate } from './exportLayout.js'
export type { ExportLayoutTemplate } from './exportLayout.js'

export interface Athlete {
  id: string
  name: string
  email: string | null
  sport: string | null
  date_of_birth: string | null
  notes: string | null
  archived: number   // 0/1 — archived athletes (e.g. historical back-catalogue imports) are hidden from the active roster
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
  focus: SuggestionGoal | null
  // Captured "fingerprint" of the coach's Excel layout (from an import), replayed
  // on export so this program looks like the coach's own sheet. null = generic.
  export_layout: ExportLayoutTemplate | null
  workouts?: Workout[]
}

// A reusable, opt-in saved style the coach can apply to future programs. Created
// from the import step's "save this program's style" toggle; lives independently
// of any one program (survives program deletion, renameable).
export interface ExportStyle {
  id: string
  name: string
  descriptor: ExportLayoutTemplate
  created_at: string
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
// Payment tracker types
// ---------------------------------------------------------------------------
// One record = one billing period (e.g. a month of coaching) for an athlete.
// Each period is captured by a single date, `paid_through`: the date coverage
// runs through and by which the next payment is due. Recurring fees are a
// sequence of periods; "renew" clones the next one forward a month. Status
// (paid/overdue/due soon/expiring) is derived, never stored — see payments.ts.

// Derived payment state (computed by shared/payments.ts, never stored):
//  - paid          : settled, paid_through still comfortably ahead
//  - expiring_soon : paid but coverage runs out within the reminder window
//  - overdue       : unpaid and paid_through has passed
//  - due_soon      : unpaid and paid_through within the reminder window
//  - upcoming      : unpaid, paid_through further out
export type PaymentStatus = 'paid' | 'expiring_soon' | 'overdue' | 'due_soon' | 'upcoming'

export interface Payment {
  id: string
  athlete_id: string
  amount: number
  currency: string         // per-record (configurable), e.g. 'SEK', 'USD'
  start_date: string | null // ISO date — coverage window start (optional)
  paid_through: string     // ISO date — coverage end / next payment due by this date
  paid: number             // 0/1
  paid_at: string | null   // ISO date when marked paid
  notes: string | null
  created_at: string
  updated_at: string
}

export interface CreatePaymentBody {
  athlete_id: string
  amount: number
  currency: string
  start_date?: string | null
  paid_through: string
  paid?: boolean
  paid_at?: string | null
  notes?: string | null
}

export interface UpdatePaymentBody {
  amount?: number
  currency?: string
  start_date?: string | null
  paid_through?: string
  paid?: boolean
  paid_at?: string | null
  notes?: string | null
}

// Per-athlete dashboard reminder: the athlete's current (latest) payment plus
// its derived status, included only when it needs the coach's attention.
export interface PaymentAlert {
  athleteId: string
  athleteName: string
  payment: Payment
  status: PaymentStatus
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
// External program import types (Feature 4) — arbitrary Excel files, not
// CoachBoard's own export. Parser discovers structure rather than replaying it.
// ---------------------------------------------------------------------------

export type ExternalColumnKey = 'exercise' | 'sets' | 'reps' | 'load' | 'rpe'

export interface ExternalColumnMapping {
  // 1-based worksheet column index detected for each key, or null if not found
  exercise: number | null
  sets: number | null
  reps: number | null
  load: number | null
  rpe: number | null
  rpeFromRir: boolean   // true when the RPE column was actually an RIR column (converted)
}

export interface ExternalExerciseRow {
  weekIndex: number      // 0-based; 0 if no week markers found
  dayIndex: number       // 0-based within the week; 0 if no day markers found
  weekLabel: string      // e.g. "Week 1" (raw detected text or synthesized)
  dayLabel: string       // e.g. "Day 1" / "Monday" / "Upper"
  name: string
  sets: string | null
  reps: string | null
  load: string | null    // null for bodyweight / blank; = "Load Used" in horizontal layout
  rpe: string | null     // post-RIR-conversion
  sheetRow: number       // source row for traceability in warnings
  // Extra columns captured from CoachBoard-style horizontal sheets (optional;
  // the vertical parser leaves these undefined).
  intensity?: string | null  // "Intensity/Weight" — prescribed
  loadCap?: number | null    // "Load Cap" — prescribed weight
  restTime?: string | null   // "Rest Time"
  // Server-internal: absolute 1-based worksheet columns for each writable field
  // on this row (sheetRow). Used only by the scaffold export engine to locate and
  // rewrite the original file's cells; ignored by capture/commit and the client.
  // `name` may be a per-week column or a single shared column (same value across
  // weeks ⇒ a shared movement-name column, as in some horizontal layouts).
  refillCols?: {
    name: number | null
    sets: number | null
    reps: number | null
    load: number | null
    rpe: number | null
    erpe: number | null
  }
}

export type ExternalLayout = 'horizontal' | 'vertical' | 'block-grid' | 'week-grid'

export interface ExternalImportWarning {
  sheetRow?: number
  message: string
}

export interface ExternalImportPreview {
  layout: ExternalLayout
  columnMapping: ExternalColumnMapping
  weeks: number
  days: number           // distinct (week,day) blocks total
  exerciseCount: number
  exercises: ExternalExerciseRow[]
  warnings: ExternalImportWarning[]
  errors: string[]       // fatal; non-empty means the file cannot be imported
  // Best-guess training focus from rep ranges / RPE arc — pre-selects the focus
  // dropdown in the wizard. null when there aren't enough numeric reps to guess.
  suggestedFocus: SuggestionGoal | null
  // Captured layout "fingerprint" (colors, fonts, orientation, day labels) of the
  // uploaded file, persisted on the program so it re-exports in the coach's style.
  // null when no exercises were detected (nothing to capture from).
  layoutTemplate: ExportLayoutTemplate | null
}

export interface ExternalImportCommitResult {
  programId: string
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
  trainingDaysPerWeek: number  // 3–5, used only when layout === 'split'
  startDate: string            // ISO date — first day of new block
  // Day structure for the new block. 'source' (default) mirrors the source
  // program's last-week layout — preserving full-body (SBD) days, training
  // frequency and per-lift accessories. 'split' uses the generic one-lift-per-day
  // 3/4/5 split keyed by trainingDaysPerWeek.
  layout?: 'source' | 'split'
  // Optional style nudges from the coach's profile (Feature 5c). Omitted when
  // the coach resets to generic defaults or has too few programs to learn from.
  style?: SuggestionStyleAdjust
  // Opt-in (default false): when a main lift's day carries NO accessories, fill
  // the gap with weak-point-relevant suggestions from the powerlifting knowledge
  // base (shared/knowledge.ts), tagged via suggestion_note. Never replaces
  // accessories carried over from the source program — see the knowledge.ts
  // "support, never override" contract.
  enrichAccessories?: boolean
}

export interface SuggestionStyleAdjust {
  startRpe?: number   // replaces a ramping template's week-1 RPE
  peakRpe?: number    // caps / targets the final-week RPE
  repBias?: number    // ±reps shift applied where it doesn't fight the goal
}

// ---------------------------------------------------------------------------
// Coach-style learning (Feature 5) — fingerprints + aggregated style profile
// ---------------------------------------------------------------------------

export type RepRangeBucket = '1-3' | '4-6' | '6-10' | '10+'
export type RampDirection = 'rising' | 'flat' | 'wave'
export type VolumeDirection = 'rising' | 'flat' | 'tapering'

// Per-program signals — computed on demand from a program's workouts/exercises.
export interface ProgramFingerprint {
  programId: string
  name: string
  focus: SuggestionGoal | null
  blockWeeks: number
  daysPerWeek: number
  repRangeBucket: RepRangeBucket
  startRpe: number | null
  peakRpe: number | null
  volumeDirection: VolumeDirection
  intensityRamp: RampDirection
}

// Rolling aggregate across the coach's completed/archived programs (optionally
// scoped to one focus). `usable` is false below the minimum sample size.
export interface CoachStyleProfile {
  focus: SuggestionGoal | null      // the focus this profile was scoped to (null = all)
  sampleSize: number
  usable: boolean
  preferredBlockWeeks: number | null
  preferredDaysPerWeek: number | null
  preferredRepRange: RepRangeBucket | null
  typicalStartRpe: number | null
  typicalPeakRpe: number | null
  volumePattern: VolumeDirection | null
  intensityPattern: RampDirection | null
  sourcePrograms: Array<{ programId: string; name: string }>
}

export const STYLE_MIN_SAMPLE = 3

// ---------------------------------------------------------------------------
// Periodization pattern detection (Feature 5d) — when several of the coach's
// fingerprints share a recognisable shape, group them into a named pattern that
// pre-fills the suggestion wizard with the coach's own typical parameters.
// ---------------------------------------------------------------------------

export type PeriodizationPatternId =
  | 'linear_progression'
  | 'wave_loading'
  | 'accumulation_intensification'
  | 'repeated_effort'

// Static metadata for each detectable pattern — shared so the client wizard can
// label patterns and the server can map a pattern to the generic template it
// pre-fills. `goal`/`templateId` reference the existing SUGGESTION_TEMPLATES.
export interface PeriodizationPatternInfo {
  id: PeriodizationPatternId
  label: string
  description: string   // plain-English summary of the detection rule
  goal: SuggestionGoal
  templateId: string
}

export const PERIODIZATION_PATTERNS: PeriodizationPatternInfo[] = [
  {
    id: 'linear_progression',
    label: 'Linear Progression',
    description: 'Rising intensity with flat volume in the 3–6 rep range',
    goal: 'strength',
    templateId: 'strength_linear',
  },
  {
    id: 'wave_loading',
    label: 'Wave Loading',
    description: 'Intensity oscillates up and down across the weeks',
    goal: 'strength',
    templateId: 'strength_wave',
  },
  {
    id: 'accumulation_intensification',
    label: 'Accumulation → Intensification',
    description: 'Volume tapers while intensity rises within the block',
    goal: 'hypertrophy',
    templateId: 'hypertrophy_accumulation',
  },
  {
    id: 'repeated_effort',
    label: 'Repeated Effort',
    description: 'Flat intensity and volume, holding around RPE 8',
    goal: 'hypertrophy',
    templateId: 'hypertrophy_repeated_effort',
  },
]

// A pattern the coach actually exhibits: the static metadata plus the typical
// parameters derived from the matching programs, used to pre-fill the wizard.
export interface DetectedPattern extends PeriodizationPatternInfo {
  sampleSize: number                 // matching programs (≥ STYLE_MIN_SAMPLE)
  preferredBlockWeeks: number
  preferredDaysPerWeek: number
  preferredRepRange: RepRangeBucket | null
  typicalStartRpe: number | null
  typicalPeakRpe: number | null
  sourcePrograms: Array<{ programId: string; name: string }>
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
  // Optional: copy the export_layout (and enabled_columns) of an existing
  // program into this new one, so a manually-created program can reuse a coach's
  // saved style without going through the generate-new-program flow.
  style_source_program_id?: string | null
  // Optional: apply a saved style from the export-style library (takes
  // precedence over style_source_program_id). This is what the New Program
  // "Copy style from a previous program" picker sends.
  export_style_id?: string | null
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
