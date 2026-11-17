// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { useRef } from 'react'
import { fireEvent, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { keyIsForPage } from './analysisKeys'
import AnalysisStage from './AnalysisStage'
import { renderScreen } from '../../test/render'

// Keys and the playback bar on the bar path pages (BP15, BP16).

describe('keyIsForPage', () => {
  const press = (target: HTMLElement, init: KeyboardEventInit) => {
    let seen: boolean | null = null
    const h = (e: KeyboardEvent) => { seen = keyIsForPage(e) }
    window.addEventListener('keydown', h)
    fireEvent.keyDown(target, init)
    window.removeEventListener('keydown', h)
    return seen
  }
  it('a plain key is the page’s, except while typing in a field', () => {
    const input = document.body.appendChild(document.createElement('input'))
    expect(press(document.body, { key: 't' })).toBe(true)
    expect(press(input, { key: 't' })).toBe(false)
    // Ctrl+S saves from inside a field too.
    expect(press(input, { key: 's', ctrlKey: true })).toBe(true)
    input.remove()
  })
  it('a button keeps Space and Enter for itself', () => {
    const button = document.body.appendChild(document.createElement('button'))
    expect(press(button, { key: ' ' })).toBe(false)
    expect(press(button, { key: 'ArrowRight' })).toBe(true)
    button.remove()
  })
  it('nothing while a dialog is open', () => {
    const dialog = document.body.appendChild(document.createElement('div'))
    dialog.setAttribute('role', 'dialog')
    expect(press(document.body, { key: ' ' })).toBe(false)
    dialog.remove()
  })
})

// jsdom has no media playback: the element's clock and play/pause are stubbed.
let clock = 0
let paused = true
beforeEach(() => {
  clock = 10
  paused = true
  Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { configurable: true, get: () => clock, set: (v: number) => { clock = v } })
  Object.defineProperty(HTMLMediaElement.prototype, 'duration', { configurable: true, get: () => 60 })
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', { configurable: true, get: () => paused })
  HTMLMediaElement.prototype.play = vi.fn(() => { paused = false; return Promise.resolve() })
  HTMLMediaElement.prototype.pause = vi.fn(() => { paused = true })
  HTMLCanvasElement.prototype.getContext = vi.fn(() => null) as never
})

function Stage({ keyboard }: { keyboard: boolean }) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const empty = useRef<never[]>([])
  return (
    <AnalysisStage
      src="clip.mp4" videoRef={videoRef} seed={null} samples={null} livePathRef={empty}
      onPlaceSeed={() => {}} onLoadedMetadata={() => {}} onTimeUpdate={() => {}} disabled
      color="#34d399" mode="seed" calibration={null} onCalibratePoint={() => {}}
      keyboard={keyboard} repStarts={[1.5, 4.25]}
    />
  )
}

const rep = (index: number, startT: number) => ({
  index, startT, endT: startT + 0.9, durationMs: 900, romPx: 200, meanVelocityPxS: 150, peakVelocityPxS: 200,
  romM: 0.75, meanVelocity: 0.55, peakVelocity: 0.74, meanPropulsiveVelocity: 0.6, propulsiveFraction: 0.9,
})
function StripStage() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const empty = useRef<never[]>([])
  const samples = Array.from({ length: 240 }, (_, i) => ({ t: i / 30, x: 300, y: 200 }))
  return (
    <AnalysisStage
      src="clip.mp4" videoRef={videoRef} seed={null} samples={samples} livePathRef={empty}
      onPlaceSeed={() => {}} onLoadedMetadata={() => {}} onTimeUpdate={() => {}} disabled
      color="#34d399" mode="seed" calibration={null} onCalibratePoint={() => {}}
      reps={[rep(0, 1.8), rep(1, 4.4)]}
    />
  )
}

describe('AnalysisStage — the rep strip (BP17)', () => {
  it('shows the chosen range before anything is tracked, with no reps to loop', () => {
    function Untracked() {
      const videoRef = useRef<HTMLVideoElement | null>(null)
      const empty = useRef<never[]>([])
      return (
        <AnalysisStage
          src="clip.mp4" videoRef={videoRef} seed={null} samples={null} livePathRef={empty}
          onPlaceSeed={() => {}} onLoadedMetadata={() => {}} onTimeUpdate={() => {}} disabled
          color="#34d399" mode="seed" calibration={null} onCalibratePoint={() => {}}
          trackRange={{ from: 1, to: 6 }}
        />
      )
    }
    renderScreen(<Untracked />)
    expect(screen.getByRole('group', { name: 'Reps in the clip' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Loop rep' })).toBeNull()
  })

  it('stays away while the clip’s length is not known', () => {
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', { configurable: true, get: () => Infinity })
    function Unknown() {
      const videoRef = useRef<HTMLVideoElement | null>(null)
      const empty = useRef<never[]>([])
      return (
        <AnalysisStage
          src="clip.webm" videoRef={videoRef} seed={null} samples={null} livePathRef={empty}
          onPlaceSeed={() => {}} onLoadedMetadata={() => {}} onTimeUpdate={() => {}} disabled
          color="#34d399" mode="seed" calibration={null} onCalibratePoint={() => {}}
          trackRange={{ from: 0, to: Infinity }}
        />
      )
    }
    renderScreen(<Unknown />)
    expect(screen.queryByRole('group', { name: 'Reps in the clip' })).toBeNull()
  })

  it('a rep block goes to the top before that rep', async () => {
    renderScreen(<StripStage />)
    await userEvent.click(screen.getByRole('button', { name: 'Rep 2' }))
    expect(clock).toBeCloseTo(2.7) // the end of rep 1
  })

  it('Loop plays the rep under the playhead over and over', async () => {
    renderScreen(<StripStage />)
    const video = document.querySelector('video')!
    clock = 5
    fireEvent(video, new Event('timeupdate'))
    await userEvent.click(screen.getByRole('button', { name: 'Loop rep' }))
    expect(screen.getByRole('button', { name: 'Looping rep 2' })).toBeTruthy()
    clock = 5.4 // past the rep's top at 5.3
    fireEvent(video, new Event('timeupdate'))
    expect(clock).toBeCloseTo(2.7)
  })
})

describe('AnalysisStage — playback', () => {
  it('steps a frame and a second from the bar, and plays slow motion', async () => {
    renderScreen(<Stage keyboard={false} />)
    await userEvent.click(screen.getByRole('button', { name: 'Forward one frame' }))
    expect(clock).toBeCloseTo(10 + 1 / 30)
    await userEvent.click(screen.getByRole('button', { name: 'Back one second' }))
    expect(clock).toBeCloseTo(9 + 1 / 30)
    const video = document.querySelector('video')!
    await userEvent.click(screen.getByRole('button', { name: '0.25×' }))
    expect(video.playbackRate).toBe(0.25)
  })

  it('Space, the arrows and 1–9 drive the video when keys are on', async () => {
    renderScreen(<Stage keyboard />)
    await userEvent.keyboard(' ')
    expect(paused).toBe(false)
    await userEvent.keyboard('{ArrowLeft}')
    expect(paused).toBe(true)
    expect(clock).toBeCloseTo(10 - 1 / 30)
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}')
    expect(clock).toBeCloseTo(11 - 1 / 30)
    await userEvent.keyboard('2')
    expect(clock).toBe(4.25)
  })

  it('answers no keys when they are off (Compare shows two stages)', async () => {
    renderScreen(<Stage keyboard={false} />)
    await userEvent.keyboard('{ArrowRight}2')
    expect(clock).toBe(10)
  })
})
