// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { act, fireEvent, renderHook } from '@testing-library/react'
import AnalysisStage, { type CalibrationLine } from './AnalysisStage'
import { usePlateMm } from './trackerColor'
import { renderScreen } from '../../test/render'

// The scale can be adjusted (BP18): drag either end, and the plate size is remembered.

// jsdom lays nothing out and plays nothing: the clip is a 640×360 picture shown
// at its own size, so a screen pixel is a video pixel. It has no PointerEvent
// either, so a pointer event would carry no position; a MouseEvent with an id
// stands in.
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
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => false)
  HTMLElement.prototype.releasePointerCapture = vi.fn()
  localStorage.clear()
})

const LINE: CalibrationLine = { a: { x: 100, y: 100 }, b: { x: 300, y: 100 } }

function setup() {
  const onChange = vi.fn()
  const onPoint = vi.fn()
  function Stage() {
    const videoRef = useRef<HTMLVideoElement | null>(null)
    const empty = useRef<never[]>([])
    return (
      <AnalysisStage
        src="clip.mp4" videoRef={videoRef} seed={null} samples={null} livePathRef={empty}
        onPlaceSeed={() => {}} onLoadedMetadata={() => {}} onTimeUpdate={() => {}} disabled={false}
        color="#34d399" mode="calibrate" calibration={LINE} onCalibratePoint={onPoint}
        onCalibrationChange={onChange}
      />
    )
  }
  renderScreen(<Stage />)
  const layer = document.querySelector('video')!.nextElementSibling as HTMLElement
  const at = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 1 })
  return { onChange, onPoint, layer, at }
}

describe('AnalysisStage — adjusting the scale line', () => {
  it('dragging an end moves that end, and the click after it is not a new first point', () => {
    const { onChange, onPoint, layer, at } = setup()
    fireEvent.pointerDown(layer, at(302, 101))
    fireEvent.pointerMove(layer, at(320, 104))
    fireEvent.pointerMove(layer, at(330, 106))
    fireEvent.pointerUp(layer, at(330, 106))
    fireEvent.click(layer, { ...at(330, 106), detail: 1 })
    expect(onChange).toHaveBeenCalledWith({ a: LINE.a, b: { x: 330, y: 106 } })
    expect(onPoint).not.toHaveBeenCalled()
    // The next click is an ordinary one again.
    fireEvent.click(layer, { ...at(50, 50), detail: 1 })
    expect(onPoint).toHaveBeenCalledWith({ x: 50, y: 50 })
  })

  it('a press on an end that never moves is still a click', () => {
    const { onChange, onPoint, layer, at } = setup()
    fireEvent.pointerDown(layer, at(100, 100))
    fireEvent.pointerUp(layer, at(100, 100))
    fireEvent.click(layer, { ...at(100, 100), detail: 1 })
    expect(onChange).not.toHaveBeenCalled()
    expect(onPoint).toHaveBeenCalledWith({ x: 100, y: 100 })
  })

  it('a press away from both ends does not grab the line', () => {
    const { onChange, layer, at } = setup()
    fireEvent.pointerDown(layer, at(200, 100))
    fireEvent.pointerMove(layer, at(220, 140))
    fireEvent.pointerUp(layer, at(220, 140))
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('usePlateMm', () => {
  it('remembers the plate size across visits', () => {
    const first = renderHook(() => usePlateMm())
    act(() => first.result.current[1](350))
    first.unmount()
    expect(renderHook(() => usePlateMm()).result.current[0]).toBe(350)
  })

  it('ignores a stored size that is not on the list', () => {
    localStorage.setItem('coachboard-plate-mm', '123')
    expect(renderHook(() => usePlateMm()).result.current[0]).toBe(450)
  })
})
