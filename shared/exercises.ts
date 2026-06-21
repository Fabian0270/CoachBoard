// ---------------------------------------------------------------------------
// Exercise library + accessory pools
// ---------------------------------------------------------------------------
// Reference DATA only: a curated powerlifting exercise directory (used by the
// day-editor autocomplete) plus extra weak-point accessories that enrich the
// suggestion engine's accessory pools. Generic movement names and qualities —
// no program tables. Aggregated into shared/knowledge.ts under the same
// "support, never override" contract documented there.
// ---------------------------------------------------------------------------

import type { Accessory, MainLift } from './knowledge.js'

// ---------------------------------------------------------------------------
// 1. Extra weak-point accessories (merged into knowledge.ts ACCESSORY_POOLS)
// ---------------------------------------------------------------------------
// Appended after the existing pools, so deterministic "first N" accessory picks
// are unchanged.

export const EXTRA_ACCESSORY_POOLS: Record<MainLift, Accessory[]> = {
  squat: [
    { name: 'Box Squat', addresses: 'controlled descent, posterior chain off the box', repRange: [3, 6] },
    { name: 'Pin Squat', addresses: 'strength from a dead stop at a sticking height', repRange: [2, 5] },
    { name: 'Safety Bar Squat', addresses: 'upper-back/quad strength, joint-friendly loading', repRange: [4, 8] },
    { name: 'Walking Lunge', addresses: 'unilateral leg drive, stability', repRange: [8, 12] },
    { name: 'Leg Curl', addresses: 'hamstring isolation', repRange: [8, 15] },
  ],
  bench: [
    { name: 'Spoto Press', addresses: 'mid-range control, pause strength', repRange: [3, 6] },
    { name: 'Board Press', addresses: 'lockout / top-end pressing strength', repRange: [3, 6] },
    { name: 'Pin Bench Press', addresses: 'dead-stop strength at the sticking point', repRange: [2, 5] },
    { name: 'Skullcrusher', addresses: 'triceps for lockout', repRange: [8, 12] },
    { name: 'Dip', addresses: 'chest/triceps pressing strength', repRange: [6, 12] },
    { name: 'Pull-Up', addresses: 'upper-back balance, the bench "shelf"', repRange: [5, 10] },
  ],
  deadlift: [
    { name: 'Snatch-Grip Deadlift', addresses: 'strength off the floor, upper-back', repRange: [3, 6] },
    { name: 'Stiff-Legged Deadlift', addresses: 'hamstrings, posterior chain', repRange: [5, 10] },
    { name: 'Good Morning', addresses: 'spinal erectors, hip hinge', repRange: [6, 10] },
    { name: 'Hip Thrust', addresses: 'glute drive at lockout', repRange: [6, 12] },
    { name: 'Glute-Ham Raise', addresses: 'hamstrings/glutes, lockout', repRange: [6, 12] },
  ],
}

// ---------------------------------------------------------------------------
// 2. Exercise directory (powerlifting-relevant subset)
// ---------------------------------------------------------------------------
// Used for the day-editor exercise autocomplete and to enrich accessory choice.
// A curated set focused on the competition lifts, their variations, and common
// powerlifting accessories.

export type MuscleGroup =
  | 'chest' | 'back' | 'shoulders' | 'legs' | 'glutes'
  | 'biceps' | 'triceps' | 'abs' | 'calves' | 'forearms'

export interface PowerliftingExercise {
  name: string
  muscleGroup: MuscleGroup
  isCompound: boolean
  /** The competition lift this primarily serves as a variation/accessory, if any. */
  mainLift?: MainLift
}

export const POWERLIFTING_EXERCISES: PowerliftingExercise[] = [
  // Squat + variations
  { name: 'Squat', muscleGroup: 'legs', isCompound: true, mainLift: 'squat' },
  { name: 'Front Squat', muscleGroup: 'legs', isCompound: true, mainLift: 'squat' },
  { name: 'Box Squat', muscleGroup: 'legs', isCompound: true, mainLift: 'squat' },
  { name: 'Pause Squat', muscleGroup: 'legs', isCompound: true, mainLift: 'squat' },
  { name: 'Pin Squat', muscleGroup: 'legs', isCompound: true, mainLift: 'squat' },
  { name: 'Safety Bar Squat', muscleGroup: 'legs', isCompound: true, mainLift: 'squat' },
  { name: 'Tempo Squat', muscleGroup: 'legs', isCompound: true, mainLift: 'squat' },
  { name: 'Hack Squat', muscleGroup: 'legs', isCompound: true },
  { name: 'Bulgarian Split Squat', muscleGroup: 'legs', isCompound: true },
  { name: 'Walking Lunge', muscleGroup: 'legs', isCompound: true },
  { name: 'Leg Press', muscleGroup: 'legs', isCompound: true },
  { name: 'Leg Extension', muscleGroup: 'legs', isCompound: false },
  { name: 'Leg Curl', muscleGroup: 'legs', isCompound: false },
  // Bench + variations
  { name: 'Bench Press', muscleGroup: 'chest', isCompound: true, mainLift: 'bench' },
  { name: 'Close-Grip Bench Press', muscleGroup: 'triceps', isCompound: true, mainLift: 'bench' },
  { name: 'Incline Bench Press', muscleGroup: 'chest', isCompound: true, mainLift: 'bench' },
  { name: 'Decline Bench Press', muscleGroup: 'chest', isCompound: true, mainLift: 'bench' },
  { name: 'Pause Bench Press', muscleGroup: 'chest', isCompound: true, mainLift: 'bench' },
  { name: 'Pin Bench Press', muscleGroup: 'chest', isCompound: true, mainLift: 'bench' },
  { name: 'Board Press', muscleGroup: 'chest', isCompound: true, mainLift: 'bench' },
  { name: 'Spoto Press', muscleGroup: 'chest', isCompound: true, mainLift: 'bench' },
  { name: 'Floor Press', muscleGroup: 'triceps', isCompound: true, mainLift: 'bench' },
  { name: 'Dumbbell Bench Press', muscleGroup: 'chest', isCompound: true },
  { name: 'Incline Dumbbell Press', muscleGroup: 'chest', isCompound: true },
  { name: 'Dip', muscleGroup: 'triceps', isCompound: true, mainLift: 'bench' },
  // Deadlift + variations
  { name: 'Deadlift', muscleGroup: 'back', isCompound: true, mainLift: 'deadlift' },
  { name: 'Sumo Deadlift', muscleGroup: 'back', isCompound: true, mainLift: 'deadlift' },
  { name: 'Romanian Deadlift', muscleGroup: 'legs', isCompound: true, mainLift: 'deadlift' },
  { name: 'Stiff-Legged Deadlift', muscleGroup: 'legs', isCompound: true, mainLift: 'deadlift' },
  { name: 'Deficit Deadlift', muscleGroup: 'back', isCompound: true, mainLift: 'deadlift' },
  { name: 'Rack Pull', muscleGroup: 'back', isCompound: true, mainLift: 'deadlift' },
  { name: 'Block Pull', muscleGroup: 'back', isCompound: true, mainLift: 'deadlift' },
  { name: 'Snatch-Grip Deadlift', muscleGroup: 'back', isCompound: true, mainLift: 'deadlift' },
  { name: 'Pause Deadlift', muscleGroup: 'back', isCompound: true, mainLift: 'deadlift' },
  { name: 'Trap Bar Deadlift', muscleGroup: 'back', isCompound: true, mainLift: 'deadlift' },
  { name: 'Good Morning', muscleGroup: 'back', isCompound: true, mainLift: 'deadlift' },
  // Pressing / shoulders / upper back
  { name: 'Overhead Press', muscleGroup: 'shoulders', isCompound: true, mainLift: 'bench' },
  { name: 'Push Press', muscleGroup: 'shoulders', isCompound: true },
  { name: 'Barbell Row', muscleGroup: 'back', isCompound: true },
  { name: 'Pendlay Row', muscleGroup: 'back', isCompound: true },
  { name: 'Dumbbell Row', muscleGroup: 'back', isCompound: true },
  { name: 'Lat Pulldown', muscleGroup: 'back', isCompound: true },
  { name: 'Pull-Up', muscleGroup: 'back', isCompound: true },
  { name: 'Chin-Up', muscleGroup: 'back', isCompound: true },
  { name: 'Face Pull', muscleGroup: 'shoulders', isCompound: false },
  { name: 'Lateral Raise', muscleGroup: 'shoulders', isCompound: false },
  { name: 'Barbell Curl', muscleGroup: 'biceps', isCompound: false },
  { name: 'Dumbbell Curl', muscleGroup: 'biceps', isCompound: false },
  { name: 'Triceps Pushdown', muscleGroup: 'triceps', isCompound: false, mainLift: 'bench' },
  { name: 'Skullcrusher', muscleGroup: 'triceps', isCompound: false, mainLift: 'bench' },
  // Posterior chain / glutes / core
  { name: 'Hip Thrust', muscleGroup: 'glutes', isCompound: true },
  { name: 'Glute-Ham Raise', muscleGroup: 'legs', isCompound: true },
  { name: 'Back Extension', muscleGroup: 'back', isCompound: false, mainLift: 'deadlift' },
  { name: 'Standing Calf Raise', muscleGroup: 'calves', isCompound: false },
  { name: 'Ab Wheel Rollout', muscleGroup: 'abs', isCompound: true },
  { name: 'Hanging Leg Raise', muscleGroup: 'abs', isCompound: false },
  { name: 'Cable Crunch', muscleGroup: 'abs', isCompound: false },
  { name: 'Plank', muscleGroup: 'abs', isCompound: false },
]

/** Flat, de-duplicated exercise-name list for autocomplete. */
export const EXERCISE_NAMES: string[] = POWERLIFTING_EXERCISES.map((e) => e.name)
