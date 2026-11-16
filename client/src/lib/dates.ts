// ---------------------------------------------------------------------------
// "Today", as the coach's calendar has it.
//
// Several screens took today as `new Date().toISOString().slice(0, 10)`, which
// is today in UTC. In Sweden that is yesterday for the first one or two hours
// after midnight: a PR logged at 00:30 was dated the day before, and a program
// generated then started a day early. These use the computer's own clock.
// ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0')

/** YYYY-MM-DD of `d` on the local calendar. */
export function localIsoDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Today on the local calendar. */
export const localToday = (): string => localIsoDate()

/**
 * The Monday a new block would most likely start on: today if today is a
 * Monday, otherwise the coming one. Programs run Monday to Sunday.
 */
export function nextMonday(from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const toMonday = (8 - d.getDay()) % 7 // Sunday 0 → 1, Monday 1 → 0, Tuesday 2 → 6
  d.setDate(d.getDate() + toMonday)
  return localIsoDate(d)
}

/** Monday of the week `iso` falls in, and the Sunday `weeks` weeks later. */
export function blockDates(iso: string, weeks: number): { start: string; end: string } {
  const [y, m, d] = iso.split('-').map(Number)
  const day = new Date(Date.UTC(y, m - 1, d))
  const back = (day.getUTCDay() + 6) % 7
  day.setUTCDate(day.getUTCDate() - back)
  const end = new Date(day)
  end.setUTCDate(day.getUTCDate() + weeks * 7 - 1)
  return { start: day.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}
