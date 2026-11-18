// ---------------------------------------------------------------------------
// Where the main window opens (P3): where the coach left it, as long as that
// spot is still on a screen. A saved position on a monitor that has since been
// unplugged would open the window off-screen, where nobody can reach it, so a
// window that is not mostly on some screen's work area starts centred instead.
// Pure — no Electron import — so the server's test runner can test it.
// ---------------------------------------------------------------------------

export interface Rect { x: number; y: number; width: number; height: number }

export interface SavedWindow extends Rect {
  maximized: boolean
}

export const DEFAULT_SIZE = { width: 1280, height: 800 }
export const MIN_SIZE = { width: 800, height: 560 }

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** Reads a stored value back, or null when it is not one we wrote. */
export function parseSavedWindow(raw: unknown): SavedWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const nums = ['x', 'y', 'width', 'height'].map((k) => r[k])
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const [x, y, width, height] = nums as number[]
  if (width < 100 || height < 100) return null
  return { x, y, width, height, maximized: r.maximized === true }
}

/**
 * The bounds to open with. `workAreas` are the connected screens' usable areas,
 * the primary first. Null `saved` (first start) or one mostly off every screen:
 * the default size, centred on the primary screen and no larger than it.
 */
export function windowBoundsFor(saved: SavedWindow | null, workAreas: Rect[]): { bounds: Rect; maximized: boolean } {
  const primary = workAreas[0] ?? { x: 0, y: 0, ...DEFAULT_SIZE }
  const centred = (): Rect => {
    const width = Math.min(DEFAULT_SIZE.width, primary.width)
    const height = Math.min(DEFAULT_SIZE.height, primary.height)
    return { x: Math.round(primary.x + (primary.width - width) / 2), y: Math.round(primary.y + (primary.height - height) / 2), width, height }
  }
  if (!saved) return { bounds: centred(), maximized: false }
  const area = saved.width * saved.height
  const best = workAreas.reduce<{ wa: Rect | null; o: number }>((acc, wa) => {
    const o = overlap(saved, wa)
    return o > acc.o ? { wa, o } : acc
  }, { wa: null, o: 0 })
  // Mostly visible means at least half of it on one screen.
  if (!best.wa || best.o < area / 2) return { bounds: centred(), maximized: saved.maximized }
  // Shrunk to fit that screen if it has become smaller (a lower resolution).
  const width = Math.max(MIN_SIZE.width, Math.min(saved.width, best.wa.width))
  const height = Math.max(MIN_SIZE.height, Math.min(saved.height, best.wa.height))
  return { bounds: { x: saved.x, y: saved.y, width, height }, maximized: saved.maximized }
}
