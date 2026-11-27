// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRef, useState } from 'react'
import { act, fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import AnalysisStage from './AnalysisStage'
import DrawControls from './DrawControls'
import { isDrawable, type Stroke } from './annotations'
import { setPenTool } from './penTool'
import { renderScreen } from '../../test/render'

// The pen's shapes (BP30, D55/D56): line, arrow, circle and a plumb line.

describe('isDrawable', () => {
  it('a plumb line is one click; a shape needs a drag; freehand needs two points', () => {
    const p = { x: 10, y: 10 }
    expect(isDrawable({ color: '#fff', points: [p], kind: 'plumb' })).toBe(true)
    expect(isDrawable({ color: '#fff', points: [p, { x: 11, y: 10 }], kind: 'line' })).toBe(false)
    expect(isDrawable({ color: '#fff', points: [p, { x: 40, y: 10 }], kind: 'arrow' })).toBe(true)
    expect(isDrawable({ color: '#fff', points: [p] })).toBe(false)
  })
})

// jsdom has no layout or PointerEvent: a 640x360 clip shown at its own size.
if (typeof window.PointerEvent === 'undefined') {
  class PointerEventStub extends MouseEvent {
    pointerId: number
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 1
    }
  }
  window.PointerEvent = PointerEventStub as unknown as typeof PointerEvent
}
beforeEach(() => {
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: () => 640 })
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: () => 360 })
  HTMLVideoElement.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360, x: 0, y: 0, toJSON() {} }) as DOMRect
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never
  HTMLElement.prototype.setPointerCapture = vi.fn()
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true)
  HTMLElement.prototype.releasePointerCapture = vi.fn()
  act(() => setPenTool('free'))
})

let drawn: Stroke[] = []
function Pen() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const empty = useRef<never[]>([])
  const [strokes, setStrokes] = useState<Stroke[]>([])
  drawn = strokes
  return (
    <>
      <DrawControls mode="draw" onModeChange={() => {}} strokes={strokes} onStrokesChange={setStrokes} />
      <AnalysisStage
        src="clip.mp4" videoRef={videoRef} seed={null} samples={null} livePathRef={empty}
        onPlaceSeed={() => {}} onLoadedMetadata={() => {}} onTimeUpdate={() => {}} disabled
        color="#34d399" mode="draw" calibration={null} onCalibratePoint={() => {}}
        strokes={strokes} onDrawStroke={(s) => setStrokes((prev) => [...prev, s])}
      />
    </>
  )
}
const at = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1 })
const layer = () => document.querySelector('video')!.nextElementSibling as HTMLElement

describe('DrawControls and the stage — shapes', () => {
  it('a line is its two ends, whatever the drag passed through', async () => {
    renderScreen(<Pen />)
    await userEvent.click(screen.getByRole('button', { name: 'Straight line' }))
    fireEvent.pointerDown(layer(), at(100, 100))
    fireEvent.pointerMove(layer(), at(150, 180))
    fireEvent.pointerMove(layer(), at(200, 120))
    fireEvent.pointerUp(layer(), at(200, 120))
    expect(drawn).toEqual([{ color: '#34d399', kind: 'line', points: [{ x: 100, y: 100 }, { x: 200, y: 120 }] }])
  })

  it('a plumb line is one click', async () => {
    renderScreen(<Pen />)
    await userEvent.click(screen.getByRole('button', { name: /Plumb line/ }))
    fireEvent.pointerDown(layer(), at(300, 200))
    fireEvent.pointerUp(layer(), at(300, 200))
    expect(drawn).toEqual([{ color: '#34d399', kind: 'plumb', points: [{ x: 300, y: 200 }] }])
  })

  it('a stray tap with a shape leaves nothing', async () => {
    renderScreen(<Pen />)
    await userEvent.click(screen.getByRole('button', { name: /Circle/ }))
    fireEvent.pointerDown(layer(), at(300, 200))
    fireEvent.pointerUp(layer(), at(300, 200))
    expect(drawn).toEqual([])
  })
})
