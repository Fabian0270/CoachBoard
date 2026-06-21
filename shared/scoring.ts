// Powerlifting strength-scoring math: IPF GL Points, DOTS, and Wilks.
//
// Same "math as data, shared between server and client, unit-tested against
// known values" pattern as rpe.ts. Every score is a pure function of
// (total, bodyweight, sex) — IPF GL additionally depends on equipment + event.
//
// Sources:
// - IPF GL coefficients: official IPF "IPF GL Coefficients 2020" table, the
//   same values used by the official calculator at goodlift.info.
//   Formula: points = total × 100 / (A − B · e^(−C · bw))
// - DOTS / Wilks: the standard published coefficient polynomials.
//   Formula: score = total × 500 / poly(bw)   (Wilks denominator already
//   folds the 500 into its coefficients; see below.)

export type Sex = 'male' | 'female'
export type Equipment = 'classic' | 'equipped'
export type MeetEvent = 'full' | 'bench'

/** Smallest bodyweight (kg) we accept; below this the formulas are meaningless. */
const MIN_BODYWEIGHT = 30

// ── IPF GL Points ───────────────────────────────────────────────────────────
// points = total × 100 / (A − B · e^(−C · bw))

interface GlCoeff { A: number; B: number; C: number }

const IPF_GL: Record<Sex, Record<Equipment, Record<MeetEvent, GlCoeff>>> = {
  male: {
    classic: {
      full: { A: 1199.72839, B: 1025.18162, C: 0.00921 },
      bench: { A: 320.98041, B: 281.40258, C: 0.01008 },
    },
    equipped: {
      full: { A: 1236.25115, B: 1449.21864, C: 0.01644 },
      bench: { A: 381.22073, B: 733.79378, C: 0.02398 },
    },
  },
  female: {
    classic: {
      full: { A: 610.32796, B: 1045.59282, C: 0.03048 },
      bench: { A: 142.40398, B: 442.52671, C: 0.04724 },
    },
    equipped: {
      full: { A: 758.63878, B: 949.31382, C: 0.02435 },
      bench: { A: 221.82209, B: 357.00377, C: 0.02937 },
    },
  },
}

/**
 * IPF GL Points. Returns null for invalid input (non-positive total, or
 * bodyweight below the usable range / denominator ≤ 0).
 */
export function ipfGlPoints(
  total: number,
  bodyweight: number,
  sex: Sex,
  equipment: Equipment,
  event: MeetEvent,
): number | null {
  if (!(total > 0) || !(bodyweight >= MIN_BODYWEIGHT)) return null
  const { A, B, C } = IPF_GL[sex][equipment][event]
  const denom = A - B * Math.exp(-C * bodyweight)
  if (!(denom > 0)) return null
  return (total * 100) / denom
}

// ── DOTS ──────────────────────────────────────────────────────────────────
// score = total × 500 / (A·bw⁴ + B·bw³ + C·bw² + D·bw + E)

const DOTS_COEFF: Record<Sex, [number, number, number, number, number]> = {
  male: [-0.000001093, 0.0007391293, -0.1918759221, 24.0900756, -307.75076],
  female: [-0.0000010706, 0.0005158568, -0.1126655495, 13.6175032, -57.96288],
}

export function dots(total: number, bodyweight: number, sex: Sex): number | null {
  if (!(total > 0) || !(bodyweight >= MIN_BODYWEIGHT)) return null
  const [a, b, c, d, e] = DOTS_COEFF[sex]
  const bw = bodyweight
  const denom = a * bw ** 4 + b * bw ** 3 + c * bw ** 2 + d * bw + e
  if (!(denom > 0)) return null
  return (total * 500) / denom
}

// ── Wilks (original 1995 formula) ───────────────────────────────────────────
// coeff = 500 / (a + b·bw + c·bw² + d·bw³ + e·bw⁴ + f·bw⁵);  score = total × coeff

const WILKS_COEFF: Record<Sex, [number, number, number, number, number, number]> = {
  male: [-216.0475144, 16.2606339, -0.002388645, -0.00113732, 7.01863e-6, -1.291e-8],
  female: [594.31747775582, -27.23842536447, 0.82112226871, -0.00930733913, 0.00004731582, -0.00000009054],
}

export function wilks(total: number, bodyweight: number, sex: Sex): number | null {
  if (!(total > 0) || !(bodyweight >= MIN_BODYWEIGHT)) return null
  const [a, b, c, d, e, f] = WILKS_COEFF[sex]
  const bw = bodyweight
  const denom = a + b * bw + c * bw ** 2 + d * bw ** 3 + e * bw ** 4 + f * bw ** 5
  if (!(denom > 0)) return null
  return (total * 500) / denom
}

export interface ScoreInput {
  total: number
  bodyweight: number
  sex: Sex
  equipment: Equipment
  event: MeetEvent
}

export interface Scores {
  dots: number | null
  wilks: number | null
  ipfGl: number | null
}

/** All three scores at once. */
export function allScores(input: ScoreInput): Scores {
  const { total, bodyweight, sex, equipment, event } = input
  return {
    dots: dots(total, bodyweight, sex),
    wilks: wilks(total, bodyweight, sex),
    ipfGl: ipfGlPoints(total, bodyweight, sex, equipment, event),
  }
}
