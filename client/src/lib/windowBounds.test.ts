import { describe, it, expect } from 'vitest'
// The Electron side has no test runner; this module is pure, so it is tested here.
import { parseSavedWindow, windowBoundsFor, DEFAULT_SIZE } from '../../../electron/src/windowBounds'

// P3: the window opens where the coach left it, as long as that is on a screen.

const laptop = { x: 0, y: 0, width: 1920, height: 1040 }
const second = { x: 1920, y: 0, width: 2560, height: 1400 }

describe('windowBoundsFor', () => {
  it('first start: the default size, centred on the primary screen', () => {
    expect(windowBoundsFor(null, [laptop])).toEqual({
      bounds: { x: 320, y: 120, width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height }, maximized: false,
    })
  })

  it('reopens where it was, on the second screen too, maximised or not', () => {
    const saved = { x: 2100, y: 80, width: 1600, height: 1000, maximized: true }
    expect(windowBoundsFor(saved, [laptop, second])).toEqual({ bounds: { x: 2100, y: 80, width: 1600, height: 1000 }, maximized: true })
  })

  it('a spot on a monitor that is gone opens centred instead', () => {
    const saved = { x: 2100, y: 80, width: 1600, height: 1000, maximized: false }
    expect(windowBoundsFor(saved, [laptop]).bounds).toEqual({ x: 320, y: 120, width: 1280, height: 800 })
  })

  it('mostly off-screen counts as gone; partly off is kept', () => {
    expect(windowBoundsFor({ x: 1500, y: 100, width: 1200, height: 800, maximized: false }, [laptop]).bounds.x).toBe(320)
    expect(windowBoundsFor({ x: 1000, y: 100, width: 1200, height: 800, maximized: false }, [laptop]).bounds.x).toBe(1000)
  })

  it('a screen that got smaller shrinks the window to fit, not below the minimum', () => {
    const saved = { x: 0, y: 0, width: 2400, height: 1300, maximized: false }
    expect(windowBoundsFor(saved, [laptop]).bounds).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
  })

  it('a small screen never gets a window bigger than itself on first start', () => {
    expect(windowBoundsFor(null, [{ x: 0, y: 0, width: 1024, height: 700 }]).bounds).toEqual({ x: 0, y: 0, width: 1024, height: 700 })
  })
})

describe('parseSavedWindow', () => {
  it('reads what was saved, and nothing else', () => {
    expect(parseSavedWindow({ x: 1, y: 2, width: 900, height: 700, maximized: true })).toEqual({ x: 1, y: 2, width: 900, height: 700, maximized: true })
    expect(parseSavedWindow({ x: 1, y: 2, width: 900 })).toBeNull()
    expect(parseSavedWindow({ x: 'a', y: 2, width: 900, height: 700 })).toBeNull()
    expect(parseSavedWindow({ x: 0, y: 0, width: 10, height: 10 })).toBeNull()
    expect(parseSavedWindow(null)).toBeNull()
  })
})
