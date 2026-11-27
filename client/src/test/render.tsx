import type { ReactElement } from 'react'
import { afterEach, vi } from 'vitest'
import { cleanup, render, type RenderResult } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ToastProvider } from '../components/ui/toast'
import { ConfirmProvider } from '../components/ui/confirm-dialog'

// ---------------------------------------------------------------------------
// Rendering real screens in tests.
//
// Component tests opt in to a browser-like environment with a first-line
// comment, `// @vitest-environment jsdom`; everything else keeps running in
// plain Node. Screens are rendered inside the same providers App.tsx gives
// them, and talk to a fake server (`serve`) instead of the embedded one.
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// jsdom has no ResizeObserver, which the charts' container needs; the app's
// Chromium does. Charts draw nothing at jsdom's zero size, which is fine: the
// tests read the words around them.
if (typeof window !== 'undefined') {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
}

/** What a fake route answers: a status and JSON body, or a network failure. */
export type FakeResponse = { status?: number; body?: unknown } | 'network-error'
// A handler may answer later (a promise), so a test can hold a save "in flight"
// and act while it is — which is the only way to test what happens in between.
type Handler = FakeResponse | ((url: URL, init?: RequestInit) => FakeResponse | Promise<FakeResponse>)

export interface FakeServer {
  /** Every request made, as "METHOD /path?query". */
  calls: string[]
  /** Replace what a route answers from now on. */
  set(route: string, handler: Handler): void
}

/**
 * Stubs `fetch` with a route table. Keys are "METHOD /path" or "/path" (any
 * method); the query string is ignored when matching. An unknown route
 * answers 404, so a screen asking for something the test did not expect shows
 * up as a failure rather than a hang.
 */
export function serve(routes: Record<string, Handler>): FakeServer {
  const table = new Map(Object.entries(routes))
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://127.0.0.1')
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push(`${method} ${url.pathname}${url.search}`)
    const handler = table.get(`${method} ${url.pathname}`) ?? table.get(url.pathname)
    const answer: FakeResponse = typeof handler === 'function' ? await handler(url, init) : handler ?? { status: 404, body: { error: 'Not found' } }
    if (answer === 'network-error') throw new TypeError('Failed to fetch')
    // A 204 may not carry a body at all — the Response constructor throws, which
    // the code under test would see as a network failure.
    if (answer.status === 204) return new Response(null, { status: 204 })
    return new Response(JSON.stringify(answer.body ?? null), {
      status: answer.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }))
  return { calls, set: (route, handler) => table.set(route, handler) }
}

/**
 * Renders `ui` at `path` inside the app's providers. `route` is the router
 * pattern the screen expects (e.g. "/programs/:id"), so useParams works.
 */
export function renderScreen(ui: ReactElement, { path = '/', route = '*' }: { path?: string; route?: string } = {}): RenderResult {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <ConfirmProvider>
          <Routes>
            <Route path={route} element={ui} />
          </Routes>
        </ConfirmProvider>
      </ToastProvider>
    </MemoryRouter>,
  )
}
