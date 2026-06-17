import { targetWeight } from 'coachboard-shared/rpe'
import type { WeekSlot } from 'coachboard-shared'

// Server-only type — includes the generate function that the client never needs.
export interface SuggestionTemplate {
  id: string
  generate: (weeks: number, e1RM: number, rpeAdjustment: number) => WeekSlot[]
}

// Round RPE to nearest 0.5, clamped to chart bounds.
function snapRpe(rpe: number): number {
  return Math.min(10, Math.max(5, Math.round(rpe * 2) / 2))
}

function makeSlot(
  week: number,
  sets: number,
  reps: number,
  rpe: number,
  e1RM: number,
  label: string,
): WeekSlot {
  const snapped = snapRpe(rpe)
  const weight = targetWeight(e1RM, reps, snapped) ?? 0
  const pct = e1RM > 0 ? Math.round((weight / e1RM) * 100) : 0
  return {
    week,
    sets,
    reps,
    targetRpe: snapped,
    weight,
    explanation: `e1RM ${Math.round(e1RM)} kg × ${pct}% → ${weight} kg for ${reps} reps @ RPE ${snapped} (${label})`,
  }
}

// Linear interpolation helper: value at position i of n-1 steps, from `from` to `to`.
function lerp(from: number, to: number, i: number, n: number): number {
  if (n <= 1) return from
  return from + ((to - from) * i) / (n - 1)
}

// For peaking templates the arc must always END at the planned peak.
// If weeks < arc.length → drop early entries. If weeks > arc.length → pad
// from the front by repeating the first entry (coach can edit the draft anyway).
function fitArc(
  arc: Array<{ sets: number; reps: number; rpe: number }>,
  weeks: number,
): Array<{ sets: number; reps: number; rpe: number }> {
  if (weeks <= arc.length) return arc.slice(arc.length - weeks)
  const pad = Array.from({ length: weeks - arc.length }, () => ({ ...arc[0] }))
  return [...pad, ...arc]
}

// ---------------------------------------------------------------------------
// The six templates
// ---------------------------------------------------------------------------

const TEMPLATES: SuggestionTemplate[] = [
  // ------------------------------------------------------------------
  // Hypertrophy / Accumulation  (4–6 weeks)
  // Inspired by CB16 Phase 1: start with higher reps and build volume,
  // then tighten the rep range and push intensity into the final weeks.
  // Sets ramp 3→5, reps ramp 10→6, RPE ramps 7.0→8.5.
  // ------------------------------------------------------------------
  {
    id: 'hypertrophy_accumulation',
    generate(weeks, e1RM, rpeAdjustment) {
      const adjusted = e1RM * (1 - rpeAdjustment)
      return Array.from({ length: weeks }, (_, i) => {
        const sets = Math.round(lerp(3, 5, i, weeks))
        const reps = Math.round(lerp(10, 6, i, weeks))
        const rpe  = lerp(7.0, 8.5, i, weeks)
        return makeSlot(i + 1, sets, reps, rpe, adjusted, 'hypertrophy accumulation')
      })
    },
  },

  // ------------------------------------------------------------------
  // Hypertrophy / Repeated Effort  (fixed 4 weeks)
  // Flat RPE 8 for three weeks, then a deliberate deload (−40% volume,
  // RPE drops to 6.5) on the final week. Based on Westside / repeated-
  // effort literature and CB's deload structure.
  // ------------------------------------------------------------------
  {
    id: 'hypertrophy_repeated_effort',
    generate(weeks, e1RM, rpeAdjustment) {
      const adjusted = e1RM * (1 - rpeAdjustment)
      return Array.from({ length: weeks }, (_, i) => {
        const week = i + 1
        const isDeload = week === weeks
        return makeSlot(
          week,
          isDeload ? 2 : 4,
          isDeload ? 8 : 10,
          isDeload ? 6.5 : 8.0,
          adjusted,
          isDeload ? 'repeated effort deload' : 'repeated effort',
        )
      })
    },
  },

  // ------------------------------------------------------------------
  // Strength / Linear Intensification  (4–6 weeks)
  // Classic strength block: 4 sets throughout, reps step down 5→3,
  // RPE ramps 7.5→9.0. Mirrors the block periodization research
  // (75–85% 1RM, 3–5 reps).
  // ------------------------------------------------------------------
  {
    id: 'strength_linear',
    generate(weeks, e1RM, rpeAdjustment) {
      const adjusted = e1RM * (1 - rpeAdjustment)
      return Array.from({ length: weeks }, (_, i) => {
        const reps = Math.round(lerp(5, 3, i, weeks))
        const rpe  = lerp(7.5, 9.0, i, weeks)
        return makeSlot(i + 1, 4, reps, rpe, adjusted, 'linear intensification')
      })
    },
  },

  // ------------------------------------------------------------------
  // Strength / Wave Loading  (6–9 weeks)
  // Directly inspired by CB16 Phase 2 (weeks 5–8): each 3-week wave
  // cycles through reps [5,4,3] at RPE [7,8,9]. The second wave resets
  // slightly heavier [7.5,8.5,9.5], after which intensity holds.
  // ------------------------------------------------------------------
  {
    id: 'strength_wave',
    generate(weeks, e1RM, rpeAdjustment) {
      const adjusted = e1RM * (1 - rpeAdjustment)
      const REPS_PATTERN = [5, 4, 3]
      const RPE_BASE     = [7, 8, 9]
      return Array.from({ length: weeks }, (_, i) => {
        const waveNum = Math.min(1, Math.floor(i / 3))  // caps at wave 2
        const step    = i % 3
        const rpe     = RPE_BASE[step] + waveNum * 0.5
        return makeSlot(
          i + 1,
          4,
          REPS_PATTERN[step],
          rpe,
          adjusted,
          `wave ${waveNum + 1} step ${step + 1}`,
        )
      })
    },
  },

  // ------------------------------------------------------------------
  // Peaking / Standard Peak  (3–4 weeks)
  // Based on CB16 Phase 4 (weeks 12–15) compressed:
  //   triples → doubles → singles → max singles.
  // Always ends at the peak regardless of week count.
  // ------------------------------------------------------------------
  {
    id: 'peaking_standard',
    generate(weeks, e1RM, rpeAdjustment) {
      const adjusted = e1RM * (1 - rpeAdjustment)
      const arc = [
        { sets: 3, reps: 3, rpe: 8.0 },
        { sets: 3, reps: 2, rpe: 8.5 },
        { sets: 2, reps: 1, rpe: 9.5 },
        { sets: 2, reps: 1, rpe: 10.0 },
      ]
      return fitArc(arc, weeks).map((e, i) =>
        makeSlot(i + 1, e.sets, e.reps, e.rpe, adjusted, 'standard peak'),
      )
    },
  },

  // ------------------------------------------------------------------
  // Peaking / Extended Peak  (5–6 weeks)
  // Based on CB16 Phase 3 + 4 (weeks 9–15): higher starting volume
  // (4×4), longer taper, still ends at singles. Suitable for lifters
  // who need more ramp-up time before hitting near-maximal singles.
  // ------------------------------------------------------------------
  {
    id: 'peaking_extended',
    generate(weeks, e1RM, rpeAdjustment) {
      const adjusted = e1RM * (1 - rpeAdjustment)
      const arc = [
        { sets: 4, reps: 4, rpe: 7.5 },
        { sets: 4, reps: 3, rpe: 8.0 },
        { sets: 3, reps: 2, rpe: 8.5 },
        { sets: 3, reps: 2, rpe: 9.0 },
        { sets: 2, reps: 1, rpe: 9.5 },
        { sets: 2, reps: 1, rpe: 10.0 },
      ]
      return fitArc(arc, weeks).map((e, i) =>
        makeSlot(i + 1, e.sets, e.reps, e.rpe, adjusted, 'extended peak'),
      )
    },
  },
]

export function findTemplate(id: string): SuggestionTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id)
}
