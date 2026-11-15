import type { ExternalExerciseRow } from 'coachboard-shared'

// ---------------------------------------------------------------------------
// Coach's prescription vs athlete's result.
//
// Load Used and Last Set RPE are only ever what the athlete wrote. Load Cap is
// the coach's fixed weight, Intensity/Weight the coach's target ("75%", "@8").
//
// An imported coach sheet used to put its weight column into Load Used and its
// RPE column into Last Set RPE, so a plan nobody had trained yet read as
// completed, and the report, 1RM estimates, max suggestions, drafts and style
// analysis all treated planned numbers as lifted ones.
//
// Each parser says whose column its load and RPE came from (from the header:
// "Load used" / "Last set RPE" are the athlete's, a plain "Load" / "RPE" the
// coach's). This moves the coach's values into the prescription fields and
// leaves load / rpe holding only results.
// ---------------------------------------------------------------------------

const PLAIN_NUMBER = /^\d+(?:[.,]\d+)?$/

/** Whether a target already states an effort ("@8", "RPE 8"). */
const hasEffort = (text: string): boolean => /@|\brpe\b/i.test(text)

export function routePrescription(row: ExternalExerciseRow): ExternalExerciseRow {
  const { loadIsResult, rpeIsResult, ...rest } = row
  let loadCap = row.loadCap ?? null
  let intensity = row.intensity ?? null
  let load = row.load
  let rpe = row.rpe

  if (load !== null && !loadIsResult) {
    if (PLAIN_NUMBER.test(load) && loadCap === null) {
      loadCap = parseFloat(load.replace(',', '.'))
    } else {
      // "75%", "140-145", or a number when a Load Cap is already set: the
      // coach's wording is kept in the target, ahead of anything already there.
      intensity = intensity ? `${load} ${intensity}` : load
    }
    load = null
  }

  if (rpe !== null && !rpeIsResult) {
    if (!intensity) intensity = `@${rpe}`
    else if (!hasEffort(intensity)) intensity = `${intensity} @${rpe}`
    rpe = null
  }

  return { ...rest, load, rpe, loadCap, intensity }
}
