// ---------------------------------------------------------------------------
// Load units, per athlete (S3, D76–D79).
//
// Loads are stored as entered, in the athlete's unit: a lb athlete's Load Cap,
// Load Used, maxes and bar path loads are lb. Everything that compares loads
// with loads (e1RM, RPE tables, load-velocity lines) works on ratios and needs
// no conversion; what changes is the label and the plates — 2.5 kg, 5 lb.
// Converting is only ever done on purpose, when the coach switches an athlete
// and says yes (D77).
// ---------------------------------------------------------------------------

export type LoadUnit = 'kg' | 'lb'

export const LOAD_UNITS: LoadUnit[] = ['kg', 'lb']

export const KG_PER_LB = 0.45359237

export function isLoadUnit(value: unknown): value is LoadUnit {
  return value === 'kg' || value === 'lb'
}

/** The unit to use for a stored value that may be missing or odd: kg. */
export function unitOf(value: unknown): LoadUnit {
  return isLoadUnit(value) ? value : 'kg'
}

/** The smallest jump a loaded bar makes: 2.5 kg, 5 lb. */
export function plateStep(unit: LoadUnit): number {
  return unit === 'lb' ? 5 : 2.5
}

/** Rounded to the nearest load the plates can make. */
export function roundToPlates(value: number, unit: LoadUnit): number {
  const step = plateStep(unit)
  return Math.round(value / step) * step
}

/** A load in another unit, not rounded. */
export function convertLoad(value: number, from: LoadUnit, to: LoadUnit): number {
  if (from === to) return value
  return from === 'kg' ? value / KG_PER_LB : value * KG_PER_LB
}

/** "182.5 kg", "405 lb" */
export function fmtLoad(value: number, unit: LoadUnit, decimals = 1): string {
  const f = 10 ** decimals
  return `${Math.round(value * f) / f} ${unit}`
}

/**
 * A number as kg, for the few fixed published values that are in kg
 * (a 20 kg bar, an empty-bar warm-up). Not for anything the coach typed.
 */
export function toKg(value: number, unit: LoadUnit): number {
  return convertLoad(value, unit, 'kg')
}
