import { getDb } from '../db.js'
import { currencyCode, homeRatesFromBase, type HomeRates } from 'coachboard-shared/revenue'

// ---------------------------------------------------------------------------
// Exchange rates for the revenue total in the coach's own currency (S5, D85).
//
// The European Central Bank's daily reference rates (EUR-based) are fetched
// when online, at most a few times a day, and kept in app_settings so the
// last good set works offline. Rates the coach types are the fallback, for a
// currency the ECB does not quote or when it has never been reachable. The
// request carries nothing about the coach: it is a plain GET of a public file.
// ---------------------------------------------------------------------------

export const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'

const ECB_KEY = 'fx_ecb'
const MANUAL_KEY = 'fx_manual'
const HOME_KEY = 'home_currency'

/** Don't ask the ECB again within this long of the last try, success or not. */
const RETRY_MS = 6 * 60 * 60 * 1000

interface EcbCache { date: string; perEur: Record<string, number>; triedAt: string }
interface ManualRates { home: string; rates: Record<string, number> }

type Fetcher = (url: string) => Promise<string>
let fetcher: Fetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`ECB answered ${res.status}`)
  return res.text()
}
/** Tests swap the network out. */
export function configureRatesFetcher(f: Fetcher | null): void {
  if (f) fetcher = f
}

async function readSetting<T>(key: string): Promise<T | null> {
  const row = await getDb().selectFrom('app_settings').select('value').where('key', '=', key).executeTakeFirst()
  if (!row) return null
  try { return JSON.parse(row.value) as T } catch { return null }
}
async function writeSetting(key: string, value: unknown): Promise<void> {
  const v = typeof value === 'string' ? value : JSON.stringify(value)
  await getDb().insertInto('app_settings').values({ key, value: v })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: v })).execute()
}

/** "<Cube time='2026-11-17'> <Cube currency='USD' rate='1.0842'/> …" → { date, perEur }. */
export function parseEcb(xml: string): { date: string; perEur: Record<string, number> } | null {
  const date = /time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1]
  const perEur: Record<string, number> = {}
  for (const m of xml.matchAll(/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g)) {
    const r = Number(m[2])
    if (r > 0) perEur[m[1]] = r
  }
  return date && Object.keys(perEur).length > 0 ? { date, perEur } : null
}

/** The ECB's rates, refreshed when the cached set is not today's and the last try is old enough. */
export async function ecbRates(now = new Date()): Promise<EcbCache | null> {
  const cached = await readSetting<EcbCache>(ECB_KEY)
  const today = now.toISOString().slice(0, 10)
  const triedRecently = cached && now.getTime() - Date.parse(cached.triedAt) < RETRY_MS
  if (cached && (cached.date === today || triedRecently)) return cached.perEur && Object.keys(cached.perEur).length ? cached : null
  try {
    const parsed = parseEcb(await fetcher(ECB_URL))
    if (!parsed) throw new Error('Could not read the ECB file')
    const fresh = { ...parsed, triedAt: now.toISOString() }
    await writeSetting(ECB_KEY, fresh)
    return fresh
  } catch {
    // Offline or refused: keep what we had, and wait before trying again.
    await writeSetting(ECB_KEY, { date: cached?.date ?? '', perEur: cached?.perEur ?? {}, triedAt: now.toISOString() })
    return cached && Object.keys(cached.perEur ?? {}).length ? cached : null
  }
}

/** The coach's own currency; when never set, the one most of their payments are in, else EUR. */
export async function homeCurrency(): Promise<string> {
  const row = await getDb().selectFrom('app_settings').select('value').where('key', '=', HOME_KEY).executeTakeFirst()
  if (row?.value) return currencyCode(row.value)
  const counts = await getDb().selectFrom('payments').select('currency').execute()
  const tally = new Map<string, number>()
  for (const p of counts) tally.set(currencyCode(p.currency), (tally.get(currencyCode(p.currency)) ?? 0) + 1)
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'EUR'
}

export async function setHomeCurrency(code: string): Promise<void> {
  await writeSetting(HOME_KEY, currencyCode(code))
}

/** Rates the coach typed: how many of their own currency one unit of each is worth. */
export async function manualRates(): Promise<Record<string, number>> {
  const home = await homeCurrency()
  const m = await readSetting<ManualRates>(MANUAL_KEY)
  // Typed against another home currency, they mean something else now.
  return m && m.home === home ? m.rates : {}
}

export async function setManualRates(rates: Record<string, number>): Promise<void> {
  const clean: Record<string, number> = {}
  for (const [c, r] of Object.entries(rates)) if (r > 0) clean[currencyCode(c)] = r
  await writeSetting(MANUAL_KEY, { home: await homeCurrency(), rates: clean })
}

export interface RateInfo {
  home: string
  rates: HomeRates
  /** Where each currency's rate came from. */
  sources: Record<string, 'ecb' | 'manual'>
  ecbDate: string | null
}

/** Every rate there is into the home currency: the ECB's first, the coach's for the rest (D85). */
export async function ratesIntoHome(now = new Date()): Promise<RateInfo> {
  const home = await homeCurrency()
  const ecb = await ecbRates(now)
  const fromEcb = ecb ? homeRatesFromBase(ecb.perEur, 'EUR', home) : { [home]: 1 }
  // ECB rates only mean something when the home currency is one it quotes.
  const ecbUsable = ecb && (home === 'EUR' || ecb.perEur[home] > 0)
  const rates: HomeRates = { [home]: 1 }
  const sources: RateInfo['sources'] = {}
  if (ecbUsable) for (const [c, r] of Object.entries(fromEcb)) if (c !== home) { rates[c] = r; sources[c] = 'ecb' }
  for (const [c, r] of Object.entries(await manualRates())) {
    if (c !== home && !(rates[c] > 0)) { rates[c] = r; sources[c] = 'manual' }
  }
  return { home, rates, sources, ecbDate: ecbUsable ? ecb!.date : null }
}
