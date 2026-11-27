import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router-dom'
import { Compass } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { useToast } from '../components/ui/toast'
import { errorMessage, getJson, getList } from '../lib/api'
import { TOUR_STOPS, words, type TourContext, type TourStop } from './stops'
import { getTourStatus, loadSample, removeSample, saveTour, type TourStatus } from './tourApi'

// ---------------------------------------------------------------------------
// The first-start tour (T1, D14–D21).
//
// A guided walkthrough: the app goes to each stop's page, waits for the thing
// it is about, dims everything else and explains it, with Back / Next / Skip
// and "4 of 24". It runs on the sample athlete. Where the coach stopped is kept
// with the app's data (T8), so it can carry on later. A stop whose target never
// appears is skipped, never left hanging.
//
// Also here: the welcome on first launch (D19), and the one-time offer to
// coaches who already have their own data when the tour first ships (D21).
// ---------------------------------------------------------------------------

interface TourApi {
  /** Start the tour (from the beginning, or from a stop), loading the sample athlete first. */
  start: (at?: number) => void
  running: boolean
}

const Ctx = createContext<TourApi>({ start: () => {}, running: false })
export const useTour = () => useContext(Ctx)

/** How long a stop waits for its target before it is skipped. */
const TARGET_WAIT_MS = 5000
const PAD = 8

async function tourContext(): Promise<TourContext> {
  const sample = await loadSample()
  const id = sample.athleteId
  const programs = id ? await getList<{ id: string; athlete_id: string | null; status: string; start_date: string | null }>('/api/programs') : []
  const mine = programs.filter((p) => p.athlete_id === id)
  const finished = mine.find((p) => p.status === 'completed') ?? null
  const draft = mine.find((p) => p.status === 'draft') ?? null
  let discordConnected = false
  try { discordConnected = !!(await getJson<{ configured?: boolean }>('/api/discord/settings')).configured } catch { /* not set up */ }
  return {
    sampleAthleteId: id,
    sampleAnalysisId: sample.analysisId ?? null,
    finishedProgramId: finished?.id ?? null,
    firstDay: finished?.start_date ?? null,
    draftProgramId: draft?.id ?? null,
    discordConnected,
  }
}

const findTarget = (id: string) => document.querySelector<HTMLElement>(`[data-tour="${id}"]`)

export default function TourProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const [status, setStatus] = useState<TourStatus | null>(null)
  const [at, setAt] = useState<number | null>(null)
  const [ctx, setCtx] = useState<TourContext | null>(null)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const [ready, setReady] = useState(false)
  const direction = useRef<1 | -1>(1)
  const cardRef = useRef<HTMLDivElement | null>(null)
  /** Set while the tour sends its own Esc to close a day, so its key handler lets it through. */
  const closingDay = useRef(false)

  useEffect(() => { getTourStatus().then(setStatus, () => setStatus(null)) }, [])

  const save = useCallback((change: Parameters<typeof saveTour>[0]) => {
    saveTour(change).then(setStatus, () => { /* the tour still works; only resuming is lost */ })
  }, [])

  const start = useCallback(async (from = 0) => {
    try {
      const c = await tourContext()
      setCtx(c)
      direction.current = 1
      setAt(Math.max(0, Math.min(from, TOUR_STOPS.length - 1)))
      save({ welcomeAnswered: true, tourAt: from })
    } catch (err) {
      toast.error(`The tour could not start: ${errorMessage(err)}`)
    }
  }, [save, toast])

  const stop: TourStop | null = at !== null ? TOUR_STOPS[at] : null

  /** Close a day that a stop opened, so the next stop's page is not behind it. */
  const closeDay = () => {
    const dialog = document.querySelector('[data-day-dialog]')
    if (!dialog) return
    // The day saves and closes on Esc. The tour's own Esc handler would
    // otherwise take it first and pause the tour (found in the packaged app).
    closingDay.current = true
    try {
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    } finally {
      closingDay.current = false
    }
  }

  const go = useCallback((next: number) => {
    closeDay()
    direction.current = next >= (at ?? 0) ? 1 : -1
    if (next < 0) return
    if (next >= TOUR_STOPS.length) { setAt(null); save({ tourAt: null, tourFinished: true }); return }
    // Hidden in the same render the stop changes, or the new card shows for a
    // moment where the last target was.
    setReady(false)
    setAt(next)
    save({ tourAt: next })
  }, [at, save])

  const quit = useCallback(() => {
    closeDay()
    toast.info('Tour paused. Carry on any time from Settings → Help.')
    setAt(null)
  }, [toast])

  // Arrive at a stop: its page, its action, then wait for its target.
  useEffect(() => {
    if (!stop || !ctx) return
    let cancelled = false
    setReady(false)
    setRect(null)
    const route = stop.route(ctx)
    if (route === null) { go((at ?? 0) + direction.current); return }
    const here = location.pathname + location.search
    if (route !== here) navigate(route)
    const began = Date.now()
    const look = () => {
      if (cancelled) return
      // The view the stop is about, on a program page; first, as the block
      // view has no day cells to open.
      if (stop.view) document.querySelector<HTMLElement>(`[data-view="${stop.view}"][aria-pressed="false"]`)?.click()
      if (stop.openDay && ctx.firstDay && !document.querySelector('[data-day-dialog]')) {
        document.querySelector<HTMLElement>(`[data-day="${ctx.firstDay}"]`)?.click()
      }
      const el = stop.target ? findTarget(stop.target) : null
      if (!stop.target || el) {
        // Taller than the screen: from its top, so what the stop is about is in view.
        const tall = !!el && el.getBoundingClientRect().height > window.innerHeight - 4 * PAD
        el?.scrollIntoView?.({ block: tall ? 'start' : 'center', behavior: 'instant' as ScrollBehavior })
        setRect(el ? el.getBoundingClientRect() : null)
        setReady(true)
        return
      }
      if (Date.now() - began > TARGET_WAIT_MS) {
        console.warn(`Tour: "${stop.id}" skipped, its target "${stop.target}" did not appear`)
        go((at ?? 0) + direction.current)
        return
      }
      window.setTimeout(look, 100)
    }
    // A moment for the page to render after navigating.
    const t = window.setTimeout(look, route !== here ? 250 : 0)
    return () => { cancelled = true; window.clearTimeout(t) }
    // location is read on arrival only; re-running on it would re-navigate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stop, ctx])

  // Follow the target as the page scrolls or resizes.
  useLayoutEffect(() => {
    if (!stop?.target || !ready) return
    const update = () => { const el = findTarget(stop.target!); if (el) setRect(el.getBoundingClientRect()) }
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const timer = window.setInterval(update, 500)
    return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); window.clearInterval(timer) }
  }, [stop, ready])

  // The tour's own keys, before the page's: the calendar also listens for the arrows.
  useEffect(() => {
    if (at === null) return
    const onKey = (e: KeyboardEvent) => {
      if (closingDay.current || e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key
      if (k !== 'ArrowRight' && k !== 'ArrowLeft' && k !== 'Escape' && k !== 'Enter') return
      // Enter on a focused button of the card is the button's own.
      if (k === 'Enter' && document.activeElement instanceof HTMLButtonElement && cardRef.current?.contains(document.activeElement)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      if (k === 'Escape') quit()
      else if (k === 'ArrowLeft') go(at - 1)
      else go(at + 1)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [at, go, quit])

  useEffect(() => { if (ready) cardRef.current?.focus() }, [ready, at])

  const finish = async (keepSample: boolean) => {
    if (!keepSample) {
      try { await removeSample() } catch (err) { toast.error(`Sample Athlete could not be removed: ${errorMessage(err)}`) }
    }
    setAt(null)
    save({ tourAt: null, tourFinished: true, checklist: { done: false } })
    navigate('/')
    if (!keepSample) window.setTimeout(() => window.location.reload(), 50)
  }

  // ── Welcome (D19) and the one-time offer to existing coaches (D21) ──────
  const showWelcome = !!status && !status.welcomeAnswered && at === null && location.pathname === '/'
  const answerWelcome = (take: boolean) => {
    if (take) void start(0)
    else save({ welcomeAnswered: true })
    setStatus((s) => (s ? { ...s, welcomeAnswered: true } : s))
  }

  return (
    <Ctx.Provider value={{ start: (n) => void start(n), running: at !== null }}>
      {children}
      {showWelcome && (
        <Dialog open onOpenChange={(o) => { if (!o) answerWelcome(false) }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2"><Compass className="h-5 w-5 text-primary" />
                {status!.hasOwnData ? 'New: a guided tour' : 'Welcome to CoachBoard'}
              </DialogTitle>
              <DialogDescription>
                {status!.hasOwnData
                  ? 'A five-minute walk through every part of CoachBoard, on a made-up athlete beside your own — so nothing of yours is touched.'
                  : 'A five-minute walk through every part of CoachBoard, on a made-up athlete, before you add your own. You can take it again any time from Settings → Help.'}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => answerWelcome(false)}>
                {status!.hasOwnData ? 'Not now' : 'Skip, I’ll look around myself'}
              </Button>
              <Button onClick={() => answerWelcome(true)}>Take the tour</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      {stop && ctx && ready && createPortal(
        <TourOverlay
          stop={stop} ctx={ctx} index={at!} rect={rect} cardRef={cardRef}
          onBack={() => go(at! - 1)} onNext={() => go(at! + 1)} onSkip={quit} onFinish={finish}
        />,
        document.body,
      )}
    </Ctx.Provider>
  )
}

function TourOverlay({ stop, ctx, index, rect: full, cardRef, onBack, onNext, onSkip, onFinish }: {
  stop: TourStop; ctx: TourContext; index: number; rect: DOMRect | null; cardRef: React.MutableRefObject<HTMLDivElement | null>
  onBack: () => void; onNext: () => void; onSkip: () => void; onFinish: (keepSample: boolean) => void
}) {
  const last = index === TOUR_STOPS.length - 1
  const vw = window.innerWidth, vh = window.innerHeight
  // Only the part on screen is outlined: an outline running off the edges
  // shows nothing of where the target ends.
  const rect = full ? (() => {
    const top = Math.max(full.top, PAD), bottom = Math.min(full.bottom, vh - PAD)
    return bottom > top
      ? { left: full.left, right: full.right, width: full.width, top, bottom, height: bottom - top }
      : full
  })() : null
  const W = Math.min(380, vw - 32)
  // The card's real height: a long stop text is taller than a guess, and ran
  // off the bottom of the screen (found in the packaged app).
  const [measured, setMeasured] = useState(0)
  // Again for each stop (its text sets the height); settles after one pass.
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight ?? 0
    if (h && Math.abs(h - measured) > 1) setMeasured(h)
  }, [index, measured, cardRef])
  // The card beside the highlight: below it if there is room, else above, else
  // to one side, kept on screen. With nothing highlighted, in the middle.
  const CARD_H = measured || 230
  let left = (vw - W) / 2, top = (vh - CARD_H) / 2
  if (rect && rect.height > vh * 0.55) {
    // A whole page area: the card in the bottom-right corner, over it.
    left = vw - W - 24
    top = vh - CARD_H - 16
  } else if (rect) {
    const below = rect.bottom + PAD + 12, above = rect.top - PAD - 12
    left = Math.min(Math.max(16, rect.left), vw - W - 16)
    if (vh - below > CARD_H) top = below
    else if (above > CARD_H) top = above - CARD_H + 10
    else if (rect.right + W + 28 < vw) { top = Math.min(Math.max(16, rect.top), vh - CARD_H - 16); left = rect.right + 16 }
    else if (rect.left - W - 28 > 0) { top = Math.min(Math.max(16, rect.top), vh - CARD_H - 16); left = rect.left - W - 16 }
    // No room anywhere around it: the bottom-right corner, over the end of it,
    // rather than over its first column (the calendar's Monday, the day's names).
    else { left = vw - W - 24; top = vh - CARD_H - 16 }
  }
  // Whatever happened above, the whole card stays on screen.
  top = Math.max(16, Math.min(top, vh - CARD_H - 16))
  left = Math.max(16, Math.min(left, vw - W - 16))
  return (
    <div className="fixed inset-0 z-[70]" data-tour-overlay="">
      {/* The dim, with the target cut out of it; clicks outside the card do nothing. */}
      {rect ? (
        <div
          aria-hidden
          className="pointer-events-none fixed rounded-lg transition-all duration-200 motion-reduce:transition-none"
          // The outline and the dim in one shadow: a ring class would be
          // overwritten by the inline shadow. Darker than a dialog's backdrop,
          // or the dark theme barely changes (measured in the packaged app).
          style={{ left: rect.left - PAD, top: rect.top - PAD, width: rect.width + 2 * PAD, height: rect.height + 2 * PAD, boxShadow: '0 0 0 2px hsl(var(--primary)), 0 0 0 9999px rgba(0,0,0,0.72)' }}
        />
      ) : (
        <div aria-hidden className="fixed inset-0 bg-black/70" />
      )}
      <div className="fixed inset-0" onMouseDown={(e) => e.preventDefault()} />
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        tabIndex={-1}
        className="fixed rounded-xl border bg-popover p-5 text-popover-foreground shadow-2xl shadow-black/40 outline-none"
        style={{ left, top, width: W }}
      >
        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-primary">{stop.chapter}</p>
        <h2 id="tour-title" className="mt-1 text-base font-semibold">{words(stop.title, ctx)}</h2>
        <p id="tour-body" className="mt-2 text-sm text-muted-foreground">{words(stop.body, ctx)}</p>
        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="num text-xs text-muted-foreground">{index + 1} of {TOUR_STOPS.length}</span>
          {last ? (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => onFinish(false)}>Remove Sample Athlete</Button>
              <Button size="sm" onClick={() => onFinish(true)}>Keep it</Button>
            </div>
          ) : (
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={onSkip}>Skip tour</Button>
              {index > 0 && <Button size="sm" variant="outline" onClick={onBack}>Back</Button>}
              <Button size="sm" onClick={onNext}>Next</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
