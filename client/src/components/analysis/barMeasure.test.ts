import { describe, it, expect } from 'vitest'
import { findBar, heightAt, stepBar, type Gray } from './barMeasure'

// BP32, D122/D123: the bar's height measured on the bar. Synthetic pictures:
// a dark bar 12 px thick across a textured background, at a known height.

const W = 600, H = 400
/** The bar's centre at x, for a bar through (300, y0) at `slope`. */
const barY = (x: number, y0: number, slope: number) => y0 + slope * (x - 300)

function picture(y0: number, { slope = 0.08, bgShift = 0, hand = false, stray = false } = {}): Gray {
  const data = new Float32Array(W * H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // A background with detail in it, which may drift (wall giving way to shirt).
      let v = 150 + 30 * Math.sin((x + bgShift * 40) / 23) + 25 * Math.cos(y / 17 + bgShift)
      // The bar, with soft edges.
      const d = Math.abs(y - barY(x, y0, slope))
      if (d < 6) v = 60
      else if (d < 8) v = 60 + (v - 60) * ((d - 6) / 2)
      // A hand over the bar near x = 380.
      if (hand && x > 370 && x < 400 && Math.abs(y - barY(x, y0, slope)) < 20) v = 200
      // Around x = 246: a hand over the bar, and a dark bar-like band 15 px below it.
      if (stray && x > 236 && x < 256) {
        const off = y - barY(x, y0, slope)
        v = Math.abs(off - 15) < 6 ? 60 : Math.abs(off) < 9 ? 200 : v
      }
      data[y * W + x] = v
    }
  }
  return { data, width: W, height: H }
}

describe('findBar', () => {
  it('finds the bar either side of a click on it, along its slope', () => {
    const cols = findBar(picture(200), { x: 300, y: 200 })!
    expect(cols.length).toBeGreaterThanOrEqual(5)
    for (const c of cols) expect(Math.abs(c.y - barY(c.x, 200, 0.08))).toBeLessThan(1)
  })

  it('a stray match is outvoted: nine columns, all on the bar', () => {
    const cols = findBar(picture(200, { stray: true }), { x: 300, y: 200 })!
    expect(cols).toHaveLength(9)
    for (const c of cols) expect(Math.abs(c.y - barY(c.x, 200, 0.08))).toBeLessThan(1)
  })

  it('a click a few pixels off the bar still finds it', () => {
    const cols = findBar(picture(200), { x: 300, y: 207 })!
    for (const c of cols) expect(Math.abs(c.y - barY(c.x, 200, 0.08))).toBeLessThan(1)
  })

  it('a click off the bar finds no bar', () => {
    expect(findBar(picture(200), { x: 300, y: 80 })).toBeNull()
  })
})

describe('stepBar', () => {
  it('follows the bar down to a sub-pixel, while what is behind it changes', () => {
    const cols = findBar(picture(200), { x: 300, y: 200 })!
    let y0 = 200
    const moved: number[] = []
    for (let i = 1; i <= 12; i++) {
      y0 += 3.4
      // The guide (the plate) says 3, wobbling: the bar is found anyway.
      const { dy } = stepBar(cols, picture(y0, { bgShift: i * 0.05 }), 3, 8)
      moved.push(dy)
    }
    for (const dy of moved) expect(Math.abs(dy - 3.4)).toBeLessThan(0.35)
    expect(Math.abs(cols[0].y - barY(cols[0].x, y0, 0.08))).toBeLessThan(1.5)
  })

  it('one wrong guide does not lose the bar: its own last movement is searched too', () => {
    const cols = findBar(picture(200), { x: 300, y: 200 })!
    let y0 = 200, own = 0
    for (let i = 1; i <= 8; i++) {
      y0 += 3.4
      // The plate's track glitches on frame 4: it says the bar jumped 20 px up.
      const guide = i === 4 ? -20 : 3
      const { dy } = stepBar(cols, picture(y0, { bgShift: i * 0.05 }), guide, 8, own)
      own = dy
      expect(Math.abs(dy - 3.4), `frame ${i}`).toBeLessThan(0.35)
    }
  })

  it('a bar that is still reads as still', () => {
    const cols = findBar(picture(250), { x: 300, y: 250 })!
    for (let i = 1; i <= 10; i++) expect(Math.abs(stepBar(cols, picture(250), 0.5, 8).dy)).toBeLessThan(0.2)
  })

  it('a hand over one column does not drag the bar with it', () => {
    const cols = findBar(picture(200), { x: 300, y: 200 })!
    const { dy } = stepBar(cols, picture(202, { hand: true }), 2, 8)
    expect(Math.abs(dy - 2)).toBeLessThan(0.35)
  })
})

describe('heightAt', () => {
  it('interpolates along the path and holds at its ends', () => {
    const track = [{ t: 0, x: 0, y: 100 }, { t: 1, x: 0, y: 200 }]
    expect(heightAt(track, 0.25)).toBeCloseTo(125)
    expect(heightAt(track, -1)).toBe(100)
    expect(heightAt(track, 5)).toBe(200)
  })
})
