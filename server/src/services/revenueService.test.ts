import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initializeDatabase, getDb } from '../db.js'
import { configureSecureStore } from './secureStore.js'
import { createAthlete } from './athleteService.js'
import { createPayment } from './paymentService.js'
import { revenueByMonth, homeRatesFromBase, totalInHome, lastMonths } from 'coachboard-shared/revenue'
import { configureRatesFetcher, parseEcb, ratesIntoHome, setHomeCurrency, setManualRates, homeCurrency } from './ratesService.js'
import { paymentsCsv, revenueSummary } from './revenueService.js'

// S5 (D84–D86): revenue spread over the months paid for, per currency and in
// the coach's own, with the ECB's rates and the coach's as the fallback.

// The real file's shape (fetched 2026-11-18), cut down.
const ECB = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope><Cube>
  <Cube time='2026-11-18'>
    <Cube currency='USD' rate='1.0968'/>
    <Cube currency='SEK' rate='11.1430'/>
    <Cube currency='NOK' rate='10.6045'/>
  </Cube>
</Cube></gesmes:Envelope>`

describe('revenueByMonth', () => {
  it('spreads a paid period evenly over the days it covers', () => {
    const m = revenueByMonth([{ amount: 900, currency: 'sek', start_date: '2026-01-01', paid_through: '2026-03-31', paid: 1 }], 'covered')
    // 31 + 28 + 31 = 90 days, 10 a day.
    expect([...m].map(([k, v]) => [k, Math.round(v.get('SEK')!)])).toEqual([['2026-01', 310], ['2026-02', 280], ['2026-03', 310]])
  })
  it('without a start date, counts in the month it runs to; unpaid ones are left out', () => {
    const m = revenueByMonth([
      { amount: 500, currency: 'EUR', start_date: null, paid_through: '2026-02-14', paid: 1 },
      { amount: 999, currency: 'EUR', start_date: '2026-02-01', paid_through: '2026-02-28', paid: 0 },
    ], 'covered')
    expect([...m].map(([k, v]) => [k, v.get('EUR')])).toEqual([['2026-02', 500]])
  })
})

describe('revenueByMonth by month paid (the default)', () => {
  it('puts a whole 6-month payment in the month it was paid', () => {
    const m = revenueByMonth([{ amount: 6000, currency: 'SEK', start_date: '2026-01-01', paid_through: '2026-06-30', paid: 1, paid_at: '2026-01-03' }])
    expect([...m].map(([k, v]) => [k, v.get('SEK')])).toEqual([['2026-01', 6000]])
  })
  it('without a paid date, the month its period ends', () => {
    const m = revenueByMonth([{ amount: 100, currency: 'EUR', start_date: '2026-01-01', paid_through: '2026-02-28', paid: 1, paid_at: null }])
    expect([...m.keys()]).toEqual(['2026-02'])
  })
})

describe('rates into the home currency', () => {
  it('turns per-EUR rates into what one unit is worth at home', () => {
    const r = homeRatesFromBase({ SEK: 11.143, USD: 1.0968 }, 'EUR', 'SEK')
    expect(r.SEK).toBe(1)
    expect(r.EUR).toBeCloseTo(11.143, 3)
    expect(r.USD).toBeCloseTo(11.143 / 1.0968, 3)
  })
  it('a total needs every currency it has', () => {
    expect(totalInHome(new Map([['SEK', 100], ['EUR', 10]]), { SEK: 1, EUR: 11 })).toBe(210)
    expect(totalInHome(new Map([['SEK', 100], ['GBP', 10]]), { SEK: 1, EUR: 11 })).toBeNull()
  })
  it('the last months, oldest first', () => {
    expect(lastMonths('2026-02', 3)).toEqual(['2025-12', '2026-01', '2026-02'])
  })
  it('reads the ECB file', () => {
    expect(parseEcb(ECB)).toEqual({ date: '2026-11-18', perEur: { USD: 1.0968, SEK: 11.143, NOK: 10.6045 } })
    expect(parseEcb('<html>down</html>')).toBeNull()
  })
})

describe('with a database', () => {
  let tmpDir: string
  let calls = 0
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-revenue-'))
    configureSecureStore({ safeStorage: null, userDataDir: tmpDir })
    await initializeDatabase(path.join(tmpDir, 'test.sqlite'))
    calls = 0
    configureRatesFetcher(async () => { calls++; return ECB })
  })
  afterEach(async () => {
    await getDb().destroy()
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ }
  })

  const seed = async () => {
    const a = await createAthlete({ name: 'Åsa Öberg' })
    await createPayment({ athlete_id: a.id, amount: 1200, currency: 'SEK', start_date: '2026-11-01', paid_through: '2026-11-30', paid: true, paid_at: '2026-11-02' })
    await createPayment({ athlete_id: a.id, amount: 100, currency: 'EUR', start_date: '2026-11-01', paid_through: '2026-12-31', paid: true, paid_at: '2026-10-28' })
    await createPayment({ athlete_id: a.id, amount: 1200, currency: 'SEK', start_date: '2026-12-01', paid_through: '2026-12-31', paid: false, notes: 'Dec, "online"' })
    return a
  }

  it('the home currency is the one most payments are in until the coach sets it', async () => {
    await seed()
    expect(await homeCurrency()).toBe('SEK')
    await setHomeCurrency('eur')
    expect(await homeCurrency()).toBe('EUR')
  })

  it('Settings and the Revenue card change the same currency', async () => {
    const { createApp } = await import('../app.js')
    const server = createApp().listen(0, '127.0.0.1')
    await new Promise((r) => server.once('listening', r))
    try {
      const base = `http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}/api`
      const put = (url: string, body: unknown) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      expect((await (await put(`${base}/settings/currency`, { home: 'nok' })).json()).home).toBe('NOK')
      expect((await (await fetch(`${base}/payments/summary`)).json()).home).toBe('NOK')
      await put(`${base}/payments/currency`, { home: 'DKK' })
      expect((await (await fetch(`${base}/settings/currency`)).json()).home).toBe('DKK')
      expect((await put(`${base}/settings/currency`, { home: 'kronor' })).status).toBe(400)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('fetches the ECB once a day and works from the cache', async () => {
    const now = new Date('2026-11-18T12:00:00Z')
    await ratesIntoHome(now)
    await ratesIntoHome(new Date('2026-11-18T13:00:00Z'))
    expect(calls).toBe(1)
  })

  it('offline, the coach’s rates fill in; a currency with neither is named', async () => {
    configureRatesFetcher(async () => { throw new Error('offline') })
    await seed()
    let s = await revenueSummary({ today: '2026-11-18', now: new Date('2026-11-18T12:00:00Z') })
    expect(s.missingRates).toEqual(['EUR'])
    // October holds the EUR payment (paid 28 Oct): no total without a rate.
    expect(s.months.at(-2)!.totalHome).toBeNull()
    expect(s.months.at(-1)!.totalHome).toBe(1200)
    await setManualRates({ EUR: 11.5 })
    s = await revenueSummary({ today: '2026-11-18', now: new Date('2026-11-18T12:00:00Z') })
    expect(s.sources).toEqual({ EUR: 'manual' })
    expect(s.missingRates).toEqual([])
  })

  it('by month paid: each payment whole in the month it was paid', async () => {
    await seed()
    const s = await revenueSummary({ today: '2026-11-18', now: new Date('2026-11-18T12:00:00Z') })
    expect(s.basis).toBe('paid')
    expect(s.months.at(-1)!.byCurrency).toEqual({ SEK: 1200 })
    expect(s.months.at(-2)!.byCurrency).toEqual({ EUR: 100 })
    expect(s.later.byCurrency).toEqual({})
    expect(s.outstanding.byCurrency).toEqual({ SEK: 1200 })
  })

  it('spread: each month per currency and in the home currency, with what is paid ahead and what is owed', async () => {
    await seed()
    const s = await revenueSummary({ today: '2026-11-18', now: new Date('2026-11-18T12:00:00Z'), basis: 'covered' })
    expect(s.home).toBe('SEK')
    expect(s.ecbDate).toBe('2026-11-18')
    const nov = s.months.at(-1)!
    expect(nov.month).toBe('2026-11')
    // 100 EUR over 61 days: 30 in November.
    expect(nov.byCurrency).toEqual({ SEK: 1200, EUR: 49.18 })
    expect(nov.totalHome).toBeCloseTo(1200 + 49.18 * 11.143, 0)
    expect(s.later.byCurrency).toEqual({ EUR: 50.82 })
    expect(s.outstanding.byCurrency).toEqual({ SEK: 1200 })
    expect(s.months).toHaveLength(12)
  })

  it('exports every payment as CSV that Excel reads', async () => {
    await seed()
    const csv = await paymentsCsv()
    expect(csv.startsWith('﻿')).toBe(true)
    const lines = csv.slice(1).trim().split('\r\n')
    expect(lines[0]).toBe('Athlete,Amount,Currency,From,Paid through,Paid,Paid on,Notes')
    expect(lines).toHaveLength(4)
    expect(lines).toContain('Åsa Öberg,1200,SEK,2026-12-01,2026-12-31,no,,"Dec, ""online"""')
  })
})
