import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { TOUR_STOPS, words, type TourContext } from './stops'

// T2: every stop's target is still marked in the pages. A page change that
// drops a data-tour attribute fails here, instead of the tour quietly
// skipping that stop for every new coach.

const src = path.resolve(__dirname, '..')
const files = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : /\.tsx$/.test(e.name) && !/\.test\./.test(e.name) ? [path.join(dir, e.name)] : [])
const marked = new Set(
  files(src).flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/data-tour="([a-z-]+)"/g)].map((m) => m[1])),
)

const ctx: TourContext = { sampleAthleteId: 'a1', finishedProgramId: 'p1', firstDay: '2026-10-19', draftProgramId: 'p2', discordConnected: false }

describe('tour stops', () => {
  it('every target is marked in a page', () => {
    const missing = TOUR_STOPS.filter((s) => s.target && !marked.has(s.target)).map((s) => `${s.id} → ${s.target}`)
    expect(missing).toEqual([])
  })

  it('ids are unique; every stop has a page, a title and a short text', () => {
    expect(new Set(TOUR_STOPS.map((s) => s.id)).size).toBe(TOUR_STOPS.length)
    for (const setup of [ctx, { ...ctx, discordConnected: true }]) {
      for (const s of TOUR_STOPS) {
        expect(s.route(setup), s.id).toMatch(/^\//)
        expect(words(s.title, setup).length, s.id).toBeGreaterThan(3)
        // One idea per stop (T3): a card, not a manual page.
        expect(words(s.body, setup).length, s.id).toBeLessThan(330)
      }
    }
  })

  it('without Discord, nothing says the Inbox is there, and Discord reads as optional', () => {
    const text = TOUR_STOPS.map((s) => `${words(s.title, ctx)} ${words(s.body, ctx)}`).join(' ')
    expect(text).not.toMatch(/the Discord inbox/i)
    expect(words(TOUR_STOPS.find((s) => s.id === 'discord')!.body, ctx)).toMatch(/^Optional/)
  })

  it('covers what was added after the stops were first written (D112)', () => {
    const text = TOUR_STOPS.map((s) => `${words(s.title, ctx)} ${words(s.body, ctx)}`).join(' ')
    for (const thing of ['Ctrl+K', 'Record with a camera', 'phone', 'revenue', 'reminder', 'second folder']) {
      expect(text, thing).toContain(thing)
    }
  })

  it('Discord: the real inbox when connected, its Settings tab when not (D23)', () => {
    const discord = TOUR_STOPS.find((s) => s.id === 'discord')!
    expect(discord.route(ctx)).toBe('/settings?tab=discord')
    expect(discord.route({ ...ctx, discordConnected: true })).toBe('/discord-inbox')
  })
})
