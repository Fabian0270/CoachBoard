import { describe, it, expect } from 'vitest'
import {
  DEFAULT_BUBBLE_SIZE,
  MAX_BUBBLE_SIZE,
  MIN_BUBBLE_SIZE,
  bubbleCircle,
  clampPlacement,
  clampTrim,
  coverSquare,
  isTrimmed,
  needsExport,
  placementFromCorner,
  type WebcamPlacement,
} from './recordingEdit'

const W = 1920
const H = 1080
const at = (x: number, y: number, size = DEFAULT_BUBBLE_SIZE): WebcamPlacement => ({ x, y, size, hidden: false })

describe('webcam placement', () => {
  it('starts in the corner and at the size the webcam used to be drawn at', () => {
    // The old compositor: diameter 22% of the short edge, 3% margin.
    const { cx, cy, radius } = bubbleCircle(placementFromCorner('bottom-right', W, H), W, H)
    expect(radius).toBeCloseTo((H * 0.22) / 2)
    expect(cx).toBeCloseTo(W - H * 0.03 - radius)
    expect(cy).toBeCloseTo(H - H * 0.03 - radius)

    const topLeft = bubbleCircle(placementFromCorner('top-left', W, H), W, H)
    expect(topLeft.cx).toBeCloseTo(H * 0.03 + topLeft.radius)
    expect(topLeft.cy).toBeCloseTo(H * 0.03 + topLeft.radius)
  })

  it('keeps a dragged circle fully inside the frame', () => {
    for (const dragged of [at(-0.5, 0.5), at(1.5, 0.5), at(0.5, -1), at(0.5, 2), at(1, 1), at(0, 0)]) {
      const { cx, cy, radius } = bubbleCircle(clampPlacement(dragged, W, H), W, H)
      expect(cx - radius).toBeGreaterThanOrEqual(-1e-6)
      expect(cx + radius).toBeLessThanOrEqual(W + 1e-6)
      expect(cy - radius).toBeGreaterThanOrEqual(-1e-6)
      expect(cy + radius).toBeLessThanOrEqual(H + 1e-6)
    }
  })

  it('leaves a circle that is already inside where the coach put it', () => {
    expect(clampPlacement(at(0.4, 0.6), W, H)).toEqual(at(0.4, 0.6))
  })

  it('limits the size, and re-fits a grown circle that would poke out', () => {
    expect(clampPlacement(at(0.5, 0.5, 5), W, H).size).toBe(MAX_BUBBLE_SIZE)
    expect(clampPlacement(at(0.5, 0.5, 0.001), W, H).size).toBe(MIN_BUBBLE_SIZE)
    const grown = bubbleCircle(clampPlacement({ ...placementFromCorner('bottom-right', W, H), size: 0.5 }, W, H), W, H)
    expect(grown.cx + grown.radius).toBeLessThanOrEqual(W + 1e-6)
    expect(grown.cy + grown.radius).toBeLessThanOrEqual(H + 1e-6)
  })

  it('is a circle in a portrait frame too (size follows the short edge)', () => {
    const { radius } = bubbleCircle(at(0.5, 0.5, 0.2), 1080, 1920)
    expect(radius).toBeCloseTo((1080 * 0.2) / 2)
  })

  it('crops the webcam to a centred square so it is not squashed', () => {
    expect(coverSquare(1280, 720)).toEqual({ sx: 280, sy: 0, size: 720 })
    expect(coverSquare(480, 640)).toEqual({ sx: 0, sy: 80, size: 480 })
  })
})

describe('trim', () => {
  it('keeps the handles in order, inside the video, and at least half a second apart', () => {
    expect(clampTrim({ start: -3, end: 99 }, 10)).toEqual({ start: 0, end: 10 })
    expect(clampTrim({ start: 4, end: 4.1 }, 10)).toEqual({ start: 4, end: 4.5 })
    expect(clampTrim({ start: 9.9, end: 10 }, 10)).toEqual({ start: 9.5, end: 10 })
    expect(clampTrim({ start: 8, end: 2 }, 10)).toEqual({ start: 8, end: 8.5 })
  })

  it('copes with a video shorter than the minimum', () => {
    expect(clampTrim({ start: 0, end: 5 }, 0.3)).toEqual({ start: 0, end: 0.3 })
    expect(clampTrim({ start: 0, end: 5 }, 0)).toEqual({ start: 0, end: 0 })
  })

  it('does not call untouched handles a trim', () => {
    expect(isTrimmed({ start: 0, end: 10 }, 10)).toBe(false)
    expect(isTrimmed({ start: 0.01, end: 9.99 }, 10)).toBe(false)
    expect(isTrimmed({ start: 1, end: 10 }, 10)).toBe(true)
    expect(isTrimmed({ start: 0, end: 8 }, 10)).toBe(true)
  })
})

describe('needsExport', () => {
  const whole = { start: 0, end: 10 }
  const shown = at(0.5, 0.5)

  it('is not needed for a plain recording without a webcam', () => {
    expect(needsExport({ hasCamera: false, placement: shown, trim: whole, duration: 10 })).toBe(false)
  })

  it('is needed whenever the webcam shows, because it is no longer drawn in while recording', () => {
    expect(needsExport({ hasCamera: true, placement: shown, trim: whole, duration: 10 })).toBe(true)
  })

  it('is not needed when the webcam is hidden and nothing is cut', () => {
    expect(needsExport({ hasCamera: true, placement: { ...shown, hidden: true }, trim: whole, duration: 10 })).toBe(false)
  })

  it('is needed for a trim, webcam or not', () => {
    expect(needsExport({ hasCamera: false, placement: shown, trim: { start: 2, end: 10 }, duration: 10 })).toBe(true)
  })
})
