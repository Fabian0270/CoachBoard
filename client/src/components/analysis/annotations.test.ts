import { describe, it, expect } from 'vitest'
import { isDrawable, simplify, type Point } from './annotations'

// The drawing itself cannot be tested here — no jsdom, no canvas — so the
// geometry is split out and checked against answers known in advance, the same
// approach tracker.core.test.ts takes with synthetic paths.

describe('simplify', () => {
  const line = (n: number): Point[] => Array.from({ length: n }, (_, i) => ({ x: i, y: 0 }))

  it('collapses a straight stroke to its endpoints', () => {
    expect(simplify(line(50), 1)).toEqual([{ x: 0, y: 0 }, { x: 49, y: 0 }])
  })

  it('keeps a corner that carries the shape', () => {
    const bent: Point[] = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 }, // the corner
      { x: 10, y: 20 },
    ]
    const out = simplify(bent, 1)
    expect(out).toContainEqual({ x: 10, y: 0 })
    expect(out.length).toBeLessThan(bent.length)
  })

  it('always keeps the first and last point', () => {
    const out = simplify(line(200), 5)
    expect(out[0]).toEqual({ x: 0, y: 0 })
    expect(out[out.length - 1]).toEqual({ x: 199, y: 0 })
  })

  it('drops more as the tolerance rises', () => {
    const wobble: Point[] = Array.from({ length: 100 }, (_, i) => ({
      x: i,
      y: Math.sin(i / 3) * 2,
    }))
    expect(simplify(wobble, 5).length).toBeLessThanOrEqual(simplify(wobble, 0.5).length)
  })

  it('leaves a stroke too short to simplify alone', () => {
    expect(simplify([{ x: 0, y: 0 }, { x: 1, y: 1 }], 1)).toHaveLength(2)
    expect(simplify([], 1)).toEqual([])
  })

  it('survives a stroke that doubles back on itself exactly', () => {
    // Identical endpoints leave no perpendicular to measure against, which is a
    // divide-by-zero if the degenerate case is not handled.
    const out = simplify([{ x: 5, y: 5 }, { x: 9, y: 9 }, { x: 5, y: 5 }], 1)
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
  })

  it('does not mutate the stroke it was given', () => {
    const input = line(20)
    simplify(input, 2)
    expect(input).toHaveLength(20)
  })
})

describe('isDrawable', () => {
  it('rejects a tap that was never a drag', () => {
    expect(isDrawable({ color: '#fff', points: [{ x: 1, y: 1 }] })).toBe(false)
    expect(isDrawable({ color: '#fff', points: [] })).toBe(false)
  })

  it('keeps a real stroke', () => {
    expect(isDrawable({ color: '#fff', points: [{ x: 1, y: 1 }, { x: 40, y: 20 }] })).toBe(true)
  })
})
