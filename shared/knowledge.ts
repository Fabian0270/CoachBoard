// ---------------------------------------------------------------------------
// Powerlifting programming knowledge base
// ---------------------------------------------------------------------------
// Curated, structured reference data so the suggestion engine has a prebuilt
// understanding of powerlifting programming: periodization models, set/rep/RPE
// standards per training goal, well-known program archetypes, and accessory
// pools per main lift.
//
// This is deliberately *data*, not logic. The engine's deterministic templates
// (server/src/lib/suggestionTemplates.ts) and pattern detection
// (PERIODIZATION_PATTERNS in types.ts) can read these constants to seed
// defaults, validate generated arcs, pick accessories, and label patterns.
//
// Numbers are typical/representative ranges synthesised from common programming
// practice (see docs/powerlifting-knowledge.md for sourcing). They are starting
// points a coach edits, not prescriptions. Loads are %1RM unless noted.
//
// ---------------------------------------------------------------------------
// DESIGN CONTRACT — support, never override
// ---------------------------------------------------------------------------
// This data exists ONLY to support the engine when it drafts programs. It must
// never override the coach's own programming or periodization. Any consumer of
// this module must honour the following precedence (highest wins):
//
//   1. What the coach explicitly entered or chose
//        (wizard inputs, edited cells, accessories already in the source program)
//   2. The coach's own learned style profile (CoachStyleProfile / DetectedPattern)
//   3. This knowledge base (generic defaults and ranges)
//   4. Hardcoded fallbacks
//
// Consequently:
//   - The engine never picks the periodization model or main-lift arc — the
//     coach does (via the chosen template / weeks / layout). This data informs
//     DEFAULTS and ACCESSORIES only, never the main-lift prescription the coach
//     selected.
//   - Output is always a `[Draft]` the coach reviews and edits before promotion.
//   - Knowledge-driven additions must be opt-in and must not replace anything the
//     coach already specified — they only fill gaps and offer suggestions.
//   - Suggestions are tagged (via `suggestion_note`) as engine-suggested so the
//     coach can see and override them.
// ---------------------------------------------------------------------------

import type { SuggestionGoal, RepRangeBucket } from './types.js'

// ---------------------------------------------------------------------------
// 1. Periodization models
// ---------------------------------------------------------------------------

export type PeriodizationModelId = 'linear' | 'block' | 'undulating' | 'conjugate' | 'wave'

export type Trend = 'rising' | 'falling' | 'flat' | 'oscillating'
export type ExperienceLevel = 'beginner' | 'intermediate' | 'advanced'

export interface PeriodizationModel {
  id: PeriodizationModelId
  label: string
  summary: string
  /** How intensity (load relative to 1RM) moves over the macrocycle. */
  intensityTrend: Trend
  /** How training volume (sets × reps) moves over the macrocycle. */
  volumeTrend: Trend
  suitedFor: ExperienceLevel[]
  typicalWeeks: [number, number]
  pros: string[]
  cons: string[]
}

export const PERIODIZATION_MODELS: PeriodizationModel[] = [
  {
    id: 'linear',
    label: 'Linear Periodization',
    summary:
      'Intensity climbs steadily relative to 1RM while volume drops over the block. ' +
      'The classic "start light/high-rep, finish heavy/low-rep" progression.',
    intensityTrend: 'rising',
    volumeTrend: 'falling',
    suitedFor: ['beginner', 'intermediate', 'advanced'],
    typicalWeeks: [3, 16],
    pros: ['Simple to run and track', 'Predictable progression', 'Good for peaking phases'],
    cons: ['Detrains qualities not being trained late in the block', 'Stalls for advanced lifters run alone'],
  },
  {
    id: 'block',
    label: 'Block Periodization',
    summary:
      'Splits the macrocycle into focused mesocycles ("blocks"): accumulation/hypertrophy → ' +
      'transmutation/strength → realization/peaking. Volume and intensity move inversely across blocks.',
    intensityTrend: 'rising',
    volumeTrend: 'falling',
    suitedFor: ['intermediate', 'advanced'],
    typicalWeeks: [9, 36],
    pros: ['Concentrated stimulus per phase', 'Strong fit for meet prep', 'Manages fatigue across long cycles'],
    cons: ['Needs planning and a known meet date', 'Less forgiving of missed sessions'],
  },
  {
    id: 'undulating',
    label: 'Undulating Periodization (DUP)',
    summary:
      'Intensity, volume and rep ranges vary frequently — daily (DUP) or weekly (WUP) — rather than ' +
      'progressing in one direction. A week might hit hypertrophy, strength and power qualities in turn.',
    intensityTrend: 'oscillating',
    volumeTrend: 'oscillating',
    suitedFor: ['intermediate', 'advanced'],
    typicalWeeks: [4, 21],
    pros: ['Trains multiple qualities concurrently', 'High frequency per lift', 'Keeps sessions varied'],
    cons: ['Harder to autoregulate fatigue', 'More moving parts to program'],
  },
  {
    id: 'conjugate',
    label: 'Conjugate (Westside)',
    summary:
      'Rotates max-effort (heavy singles on lift variations), dynamic-effort (submaximal speed work, ' +
      'often with bands/chains) and repetition-method accessory days. Variations rotated to dodge accommodation.',
    intensityTrend: 'oscillating',
    volumeTrend: 'oscillating',
    suitedFor: ['intermediate', 'advanced'],
    typicalWeeks: [6, 16],
    pros: ['Continuous variation avoids staleness', 'Builds speed and absolute strength together'],
    cons: ['Needs specialty bars/bands/chains', 'Exercise rotation is hard to learn'],
  },
  {
    id: 'wave',
    label: 'Wave Loading',
    summary:
      'Intensity climbs across a short wave (e.g. 3 weeks) then resets slightly heavier for the next wave. ' +
      'Reps usually fall as load rises within a wave (e.g. 5/4/3 @ RPE 7/8/9).',
    intensityTrend: 'oscillating',
    volumeTrend: 'flat',
    suitedFor: ['intermediate', 'advanced'],
    typicalWeeks: [3, 12],
    pros: ['Repeated exposure to heavier loads', 'Built-in light weeks aid recovery'],
    cons: ['Progression per wave can be small', 'Needs accurate starting loads'],
  },
]

// ---------------------------------------------------------------------------
// 2. Set / rep / intensity standards per training goal
// ---------------------------------------------------------------------------
// Goal vocabulary matches the engine's SuggestionGoal union so these can seed
// or sanity-check template output directly.

export interface SetRepScheme {
  goal: SuggestionGoal
  /** Human label for the emphasis within the goal. */
  emphasis: string
  repRange: [number, number]
  setRange: [number, number]
  rpeRange: [number, number]
  /** %1RM working-set range (whole percent). */
  pctRange: [number, number]
  /** Rest between main-lift sets, minutes. */
  restMinutes: [number, number]
  bucket: RepRangeBucket
  note: string
}

export const SET_REP_SCHEMES: SetRepScheme[] = [
  {
    goal: 'hypertrophy',
    emphasis: 'Accumulation / volume',
    repRange: [6, 12],
    setRange: [3, 5],
    rpeRange: [6.5, 8.5],
    pctRange: [65, 78],
    restMinutes: [1.5, 3],
    bucket: '6-10',
    note: 'Build muscle and work capacity. Stop 1–3 reps shy of failure; chase total quality volume.',
  },
  {
    goal: 'hypertrophy',
    emphasis: 'Repeated effort',
    repRange: [8, 12],
    setRange: [3, 5],
    rpeRange: [7.5, 8.5],
    pctRange: [65, 75],
    restMinutes: [1, 2],
    bucket: '6-10',
    note: 'Flat, repeatable RPE-8 work (e.g. BBB 5×10). Deload by cutting volume, not just load.',
  },
  {
    goal: 'strength',
    emphasis: 'Linear intensification',
    repRange: [3, 5],
    setRange: [3, 5],
    rpeRange: [7.5, 9],
    pctRange: [80, 90],
    restMinutes: [2, 4],
    bucket: '4-6',
    note: 'Classic strength block: reps step down 5→3 as intensity rises toward RPE 9.',
  },
  {
    goal: 'strength',
    emphasis: 'Wave loading',
    repRange: [3, 6],
    setRange: [3, 5],
    rpeRange: [7, 9.5],
    pctRange: [78, 90],
    restMinutes: [2, 4],
    bucket: '4-6',
    note: 'Repeating 3-week waves (e.g. 5/4/3) that reset slightly heavier each wave.',
  },
  {
    goal: 'peaking',
    emphasis: 'Realization / taper',
    repRange: [1, 3],
    setRange: [2, 4],
    rpeRange: [8, 10],
    pctRange: [88, 102],
    restMinutes: [3, 5],
    bucket: '1-3',
    note: 'Triples → doubles → singles into a meet. Volume drops hard; the block must END at the peak.',
  },
]

// ---------------------------------------------------------------------------
// 3. Program archetypes
// ---------------------------------------------------------------------------
// Well-known programs distilled to the parameters the wizard cares about. Use
// these to pre-fill weeks / days-per-week / focus and to label what a coach's
// own programs resemble.

export interface ProgramArchetype {
  name: string
  periodization: PeriodizationModelId
  primaryGoal: SuggestionGoal
  weeks: number | [number, number]
  daysPerWeek: number | [number, number]
  level: ExperienceLevel[]
  /** Weekly frequency per main lift, when characteristic of the program. */
  liftFrequency?: Partial<Record<'squat' | 'bench' | 'deadlift' | 'ohp', number>>
  /** Loading method the program is built around. */
  loading: 'percentage' | 'rpe' | 'both' | 'autoregulated'
  keyFeatures: string[]
}

export const PROGRAM_ARCHETYPES: ProgramArchetype[] = [
  {
    name: 'Jim Wendler 5/3/1',
    periodization: 'wave',
    primaryGoal: 'strength',
    weeks: [4, 4],
    daysPerWeek: 4,
    level: ['beginner', 'intermediate'],
    liftFrequency: { squat: 1, bench: 1, deadlift: 1, ohp: 1 },
    loading: 'percentage',
    keyFeatures: [
      'Percentages are of a Training Max = ~90% of true 1RM',
      '4-week wave: wk1 3×5, wk2 3×3, wk3 5/3/1, wk4 deload',
      'AMRAP "+" set on the top set drives progression',
      'Variations: Boring But Big (5×10 supplemental), First Set Last, Triumvirate',
    ],
  },
  {
    name: 'nSuns 5/3/1 LP',
    periodization: 'linear',
    primaryGoal: 'strength',
    weeks: [12, 12],
    daysPerWeek: [4, 6],
    level: ['intermediate'],
    loading: 'percentage',
    keyFeatures: [
      'High-volume 5/3/1 derivative with 9 working sets on the main lift',
      'AMRAP set auto-regulates the weekly Training Max bump',
      'One primary + one secondary compound per day',
    ],
  },
  {
    name: 'GZCLP / GZCL Method',
    periodization: 'linear',
    primaryGoal: 'strength',
    weeks: [12, 12],
    daysPerWeek: [3, 4],
    level: ['beginner', 'intermediate'],
    loading: 'rpe',
    keyFeatures: [
      'Tier system: T1 main (≈3×5+, heavy), T2 secondary (≈3×10+), T3 accessory (≈3×15+)',
      'Last set of each tier is an AMRAP that gates progression',
      'Volume-base progression: add load until you miss the rep target, then shift scheme',
    ],
  },
  {
    name: 'Texas Method',
    periodization: 'undulating',
    primaryGoal: 'strength',
    weeks: [8, 12],
    daysPerWeek: 3,
    level: ['intermediate'],
    loading: 'percentage',
    keyFeatures: [
      'Weekly undulation: Volume day (Mon, 5×5 ~90% of 5RM) → Light/recovery (Wed) → Intensity day (Fri, new 5RM)',
      'Bridge from novice linear progression to weekly progression',
    ],
  },
  {
    name: 'Madcow 5×5',
    periodization: 'linear',
    primaryGoal: 'strength',
    weeks: [12, 12],
    daysPerWeek: 3,
    level: ['intermediate'],
    loading: 'percentage',
    keyFeatures: [
      'Weekly linear progression with ramping 5×5 sets to a top set',
      'Heavy / light / medium weekly structure',
    ],
  },
  {
    name: 'Candito 6 Week',
    periodization: 'block',
    primaryGoal: 'peaking',
    weeks: [6, 6],
    daysPerWeek: [4, 5],
    level: ['intermediate'],
    liftFrequency: { squat: 2, bench: 3, deadlift: 2 },
    loading: 'percentage',
    keyFeatures: [
      'Short blocks: hypertrophy/conditioning → strength → heavy/peaking → test',
      'First weeks high volume, intensity rises toward a 1RM test',
    ],
  },
  {
    name: 'Sheiko',
    periodization: 'block',
    primaryGoal: 'strength',
    weeks: [4, 12],
    daysPerWeek: [3, 4],
    level: ['intermediate', 'advanced'],
    liftFrequency: { squat: 2, bench: 3, deadlift: 2 },
    loading: 'percentage',
    keyFeatures: [
      'Very high frequency and total volume at moderate intensity (mostly 70–85%)',
      'Alternating heavy and light days; lots of competition-lift variation',
      'Numbered prep/competition variants (e.g. #29, #32, #37)',
    ],
  },
  {
    name: 'Smolov / Smolov Jr',
    periodization: 'block',
    primaryGoal: 'strength',
    weeks: [3, 13],
    daysPerWeek: [3, 4],
    level: ['advanced'],
    loading: 'percentage',
    keyFeatures: [
      'Brutal high-frequency squat (or single-lift) specialization',
      'Smolov Jr is a 3-week single-lift block; full Smolov is a 13-week cycle',
    ],
  },
  {
    name: 'Calgary Barbell 8 / 16 Week',
    periodization: 'block',
    primaryGoal: 'peaking',
    weeks: [8, 16],
    daysPerWeek: [4, 5],
    level: ['intermediate', 'advanced'],
    loading: 'rpe',
    keyFeatures: [
      'RPE-driven block progression toward a meet',
      'Volume/hypertrophy → strength → peaking structure',
    ],
  },
  {
    name: 'Juggernaut Method',
    periodization: 'wave',
    primaryGoal: 'strength',
    weeks: [16, 16],
    daysPerWeek: 4,
    level: ['intermediate', 'advanced'],
    loading: 'percentage',
    keyFeatures: [
      'Four waves (10s, 8s, 5s, 3s), each: accumulation → intensification → realization → deload',
      'Built around Training Max with AMRAP-driven progression',
    ],
  },
  {
    name: 'Conjugate / Westside',
    periodization: 'conjugate',
    primaryGoal: 'strength',
    weeks: [8, 16],
    daysPerWeek: 4,
    level: ['intermediate', 'advanced'],
    loading: 'autoregulated',
    keyFeatures: [
      'Two max-effort days + two dynamic-effort days per week',
      'Dynamic effort uses ~50–60% + bands/chains for speed',
      'Max-effort lift variations rotated every 1–3 weeks',
    ],
  },
  {
    name: 'Starting Strength / GreySkull LP',
    periodization: 'linear',
    primaryGoal: 'strength',
    weeks: [8, 12],
    daysPerWeek: 3,
    level: ['beginner'],
    loading: 'percentage',
    keyFeatures: [
      'Pure novice linear progression: add load every session',
      'Full-body, low rep (3×5), squat every session',
      'GreySkull adds AMRAP top sets and resettable progression',
    ],
  },
  {
    name: 'Renaissance Periodization Hypertrophy',
    periodization: 'block',
    primaryGoal: 'hypertrophy',
    weeks: [4, 6],
    daysPerWeek: [4, 6],
    level: ['intermediate', 'advanced'],
    loading: 'autoregulated',
    keyFeatures: [
      'Volume-landmark driven: start a mesocycle at MEV, add sets weekly toward MRV',
      'RIR progression: ~3 RIR early in the block down to 0–1 RIR by the last hard week',
      'Most working sets 30–85% 1RM, 5–30 reps, 0–4 RIR',
      'Deload to maintenance volume (MV) before the next mesocycle resets at MEV',
    ],
  },
  {
    name: 'Jeff Nippard Powerbuilding System',
    periodization: 'undulating',
    primaryGoal: 'hypertrophy',
    weeks: [10, 10],
    daysPerWeek: [4, 6],
    level: ['intermediate', 'advanced'],
    loading: 'both',
    keyFeatures: [
      'Blends powerlifting strength work with bodybuilding volume',
      'Alternates full-body (strength) and upper/lower (hypertrophy) weeks',
      'Three rep zones: 1–5 (mechanical tension), 6–12, 12–20 (metabolic stress)',
      'High-effort top sets for strength + back-off volume for size; RPE/RIR + %1RM',
    ],
  },
  {
    name: 'Westside Barbell Conjugate',
    periodization: 'conjugate',
    primaryGoal: 'strength',
    weeks: [12, 16],
    daysPerWeek: 4,
    level: ['advanced'],
    liftFrequency: { squat: 2, bench: 2, deadlift: 2 },
    loading: 'autoregulated',
    keyFeatures: [
      'Max-effort lower + max-effort upper + dynamic-effort lower + dynamic-effort upper',
      'Max effort: work to a heavy single (100%+) on a rotated variation each 1–3 weeks',
      'Dynamic effort: speed work — squat/DL ~50–60%, bench ~8×3, often with bands/chains',
      'Repetition method for accessories (reverse hyper, GHR, triceps, lats, abs)',
    ],
  },
]

// ---------------------------------------------------------------------------
// 4. Accessory pools per main lift
// ---------------------------------------------------------------------------
// Accessory selection is weak-point driven. Each entry maps a movement to the
// sticking point / quality it addresses so the engine can pick relevant work
// rather than a generic list. Rep ranges are typical hypertrophy/strength
// accessory ranges, not prescriptions.

export type MainLift = 'squat' | 'bench' | 'deadlift'

export interface Accessory {
  name: string
  addresses: string
  repRange: [number, number]
}

export const ACCESSORY_POOLS: Record<MainLift, Accessory[]> = {
  squat: [
    { name: 'Front Squat', addresses: 'quad strength, upright torso', repRange: [3, 6] },
    { name: 'Pause Squat', addresses: 'out-of-the-hole strength, position', repRange: [3, 5] },
    { name: 'Tempo Squat', addresses: 'control, position, hypertrophy', repRange: [4, 8] },
    { name: 'Bulgarian Split Squat', addresses: 'unilateral quad/glute, stability', repRange: [8, 12] },
    { name: 'Leg Press', addresses: 'quad hypertrophy with low axial load', repRange: [8, 15] },
    { name: 'Leg Extension', addresses: 'quad isolation', repRange: [10, 15] },
    { name: 'Good Morning', addresses: 'posterior chain, core, leg drive', repRange: [6, 10] },
    { name: 'Hanging Leg Raise', addresses: 'trunk/bracing', repRange: [8, 15] },
  ],
  bench: [
    { name: 'Close-Grip Bench Press', addresses: 'triceps, lockout', repRange: [4, 8] },
    { name: 'Floor Press', addresses: 'lockout, triceps', repRange: [3, 6] },
    { name: 'Pause Bench Press', addresses: 'off-chest strength, position', repRange: [3, 5] },
    { name: 'Incline Bench Press', addresses: 'upper chest, shoulders', repRange: [6, 10] },
    { name: 'Dumbbell Bench Press', addresses: 'chest hypertrophy, stability', repRange: [8, 12] },
    { name: 'Overhead Press', addresses: 'shoulder strength, lockout', repRange: [5, 8] },
    { name: 'Barbell Row', addresses: 'upper-back stability, the bench "shelf"', repRange: [6, 10] },
    { name: 'Triceps Pushdown', addresses: 'triceps isolation, lockout', repRange: [10, 15] },
  ],
  deadlift: [
    { name: 'Romanian Deadlift', addresses: 'posterior chain, lockout, hamstrings', repRange: [5, 10] },
    { name: 'Deficit Deadlift', addresses: 'strength off the floor', repRange: [3, 6] },
    { name: 'Block / Rack Pull', addresses: 'lockout, top-end strength', repRange: [3, 6] },
    { name: 'Pause Deadlift', addresses: 'positioning off the floor', repRange: [2, 5] },
    { name: 'Barbell Row', addresses: 'upper-back, bar control', repRange: [6, 10] },
    { name: 'Back Extension', addresses: 'spinal erectors, glutes/hamstrings', repRange: [8, 15] },
    { name: 'Hamstring Curl', addresses: 'hamstring isolation', repRange: [8, 15] },
    { name: 'Hanging Leg Raise', addresses: 'trunk/bracing', repRange: [8, 15] },
  ],
}

// ---------------------------------------------------------------------------
// 5. Programming heuristics
// ---------------------------------------------------------------------------
// Rules of thumb the engine can lean on for defaults and validation.

export const PROGRAMMING_HEURISTICS = {
  /** A deload is typically warranted roughly every N weeks of hard training. */
  deloadEveryWeeks: [4, 6] as [number, number],
  /** Deload = cut volume ~40–60% and drop intensity ~1–2 RPE / ~10%. */
  deloadVolumeCutPct: [40, 60] as [number, number],
  /** Training Max convention used by 5/3/1-style programs. */
  trainingMaxPctOf1RM: 90,
  /** Sensible weekly working-set count per main muscle group for growth. */
  weeklySetsPerMuscle: [10, 20] as [number, number],
  /** Main-lift weekly frequency that suits each goal. */
  frequencyByGoal: {
    hypertrophy: [2, 3] as [number, number],
    strength: [2, 3] as [number, number],
    peaking: [1, 2] as [number, number],
  },
  /** Map a training day count to a common lift split (0 = Monday). */
  splitByDays: {
    3: 'Squat / Bench / Deadlift (full-lift days)',
    4: 'Upper / Lower or Squat / Bench / Deadlift / Bench',
    5: 'One primary lift per day with overlap',
  } as Record<number, string>,
} as const

// ---------------------------------------------------------------------------
// 6. Volume landmarks (Renaissance Periodization)
// ---------------------------------------------------------------------------
// RP's framework for how much weekly volume (working sets per muscle group)
// drives or limits hypertrophy. Numbers are per-muscle weekly sets and vary by
// individual and muscle; treat as planning anchors. Source: rpstrength.com.

export type VolumeLandmarkId = 'MV' | 'MEV' | 'MAV' | 'MRV'

export interface VolumeLandmark {
  id: VolumeLandmarkId
  label: string
  /** Typical weekly working sets per muscle group at this landmark. */
  weeklySetsPerMuscle: [number, number]
  meaning: string
}

export const VOLUME_LANDMARKS: VolumeLandmark[] = [
  {
    id: 'MV',
    label: 'Maintenance Volume',
    weeklySetsPerMuscle: [4, 6],
    meaning: 'Least volume that holds current muscle. Deloads drop to roughly here.',
  },
  {
    id: 'MEV',
    label: 'Minimum Effective Volume',
    weeklySetsPerMuscle: [8, 12],
    meaning: 'Lowest volume that still produces growth — where a mesocycle starts.',
  },
  {
    id: 'MAV',
    label: 'Maximum Adaptive Volume',
    weeklySetsPerMuscle: [12, 20],
    meaning: 'The productive zone you progress through across the block; best gains here.',
  },
  {
    id: 'MRV',
    label: 'Maximum Recoverable Volume',
    weeklySetsPerMuscle: [18, 22],
    meaning: 'Upper limit before recovery fails. Push toward it late in the block, then deload.',
  },
]

// How an RP-style hypertrophy mesocycle progresses: begin near MEV at higher RIR,
// add sets each week toward MRV while RIR falls, then a deload week resets to MV.
export const MESOCYCLE_PROGRESSION = {
  typicalWeeks: [4, 6] as [number, number],
  /** RIR target from first hard week → last hard week (deload excluded). */
  rirStartToEnd: [3, 0] as [number, number],
  /** Sets added per muscle group each week as fatigue allows. */
  setsAddedPerWeek: [1, 2] as [number, number],
  /** Working-set bounds RP considers stimulative. */
  repRange: [5, 30] as [number, number],
  pctRange: [30, 85] as [number, number],
  deloadResetsTo: 'MV' as VolumeLandmarkId,
} as const

// ---------------------------------------------------------------------------
// 7. Conjugate weekly template + effort methods (Westside Barbell)
// ---------------------------------------------------------------------------
// Source: westside-barbell.com. The classic four-day rotation plus the three
// "methods" it cycles. Percentages are of competition max unless noted.

export type EffortMethodId = 'max_effort' | 'dynamic_effort' | 'repetition'

export interface EffortMethod {
  id: EffortMethodId
  label: string
  pctRange: [number, number] | null   // null = work up to a top single
  scheme: string
  purpose: string
}

export const EFFORT_METHODS: EffortMethod[] = [
  {
    id: 'max_effort',
    label: 'Max Effort',
    pctRange: null,
    scheme: 'Work up to a heavy 1–3RM on a rotated lift variation',
    purpose: 'Absolute strength. Rotate the variation every 1–3 weeks to avoid CNS staleness.',
  },
  {
    id: 'dynamic_effort',
    label: 'Dynamic Effort',
    pctRange: [50, 60],
    scheme: 'Squat ~8–12×2, bench ~8–9×3, fast bar speed, often + bands/chains',
    purpose: 'Rate of force development / speed-strength. Run as a 3-week wave (e.g. 50/55/60%).',
  },
  {
    id: 'repetition',
    label: 'Repetition Method',
    pctRange: [60, 80],
    scheme: 'Higher-rep accessory work to or near failure',
    purpose: 'Hypertrophy, work capacity and weak-point bring-up (triceps, lats, posterior chain).',
  },
]

export interface ConjugateDay {
  dayOffset: number   // 0 = Monday
  label: string
  method: EffortMethodId
}

// The canonical Westside four-day week (heavy/speed alternated, 72h between
// same-pattern days). Coaches adapt the exact days.
export const CONJUGATE_TEMPLATE: ConjugateDay[] = [
  { dayOffset: 0, label: 'Max Effort Lower', method: 'max_effort' },
  { dayOffset: 1, label: 'Max Effort Upper', method: 'max_effort' },
  { dayOffset: 3, label: 'Dynamic Effort Lower', method: 'dynamic_effort' },
  { dayOffset: 4, label: 'Dynamic Effort Upper', method: 'dynamic_effort' },
]

// ---------------------------------------------------------------------------
// 8. Hypertrophy rep zones (mechanism-based, Jeff Nippard / science-based)
// ---------------------------------------------------------------------------
// Different rep ranges drive growth through different mechanisms; a complete
// program touches each. Useful for varying accessory prescriptions.

export interface RepZone {
  label: string
  repRange: [number, number]
  mechanism: string
  bestFor: string
}

export const HYPERTROPHY_REP_ZONES: RepZone[] = [
  {
    label: 'Heavy',
    repRange: [1, 5],
    mechanism: 'Mechanical tension',
    bestFor: 'Strength carryover on compound lifts; low fatigue per stimulating rep.',
  },
  {
    label: 'Moderate',
    repRange: [6, 12],
    mechanism: 'Tension + metabolic stress',
    bestFor: 'The hypertrophy "sweet spot" — most accessory and bodybuilding work.',
  },
  {
    label: 'Light',
    repRange: [12, 20],
    mechanism: 'Metabolic stress',
    bestFor: 'Isolation/pump work and joint-friendly volume; train close to failure.',
  },
]
