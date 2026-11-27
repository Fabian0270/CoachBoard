import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApiError, getJson, getList, isOffline, sendJson } from './api'

const stubFetch = (impl: () => Promise<Response> | never) => {
  vi.stubGlobal('fetch', vi.fn(impl))
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getJson', () => {
  it('returns the parsed body on success', async () => {
    stubFetch(async () => jsonResponse({ name: 'Sara' }))
    expect(await getJson<{ name: string }>('/api/athletes/1')).toEqual({ name: 'Sara' })
  })

  it('throws on a non-2xx instead of handing back the error body', async () => {
    // The old pattern called r.json() unconditionally, so a 500's {error: ...}
    // object flowed into state as if it were data and failed an Array.isArray
    // check further down — arriving on screen as a zero.
    stubFetch(async () => jsonResponse({ error: 'Internal server error' }, 500))
    await expect(getJson('/api/athletes')).rejects.toBeInstanceOf(ApiError)
    await expect(getJson('/api/athletes')).rejects.toThrow(/500/)
  })

  it('reports an unreachable server distinctly from a server error', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const err = await getJson('/api/athletes').catch((e: unknown) => e)
    expect(isOffline(err)).toBe(true)
    // The server is embedded in the app, so this is "not started yet" rather
    // than "you have no internet" — the message must not blame the network.
    expect((err as ApiError).message).not.toMatch(/internet|offline/i)
  })

  it('throws rather than returning undefined when the body is not JSON', async () => {
    stubFetch(async () => new Response('<!doctype html>', { status: 200 }))
    await expect(getJson('/api/athletes')).rejects.toBeInstanceOf(ApiError)
  })
})

describe('getList', () => {
  it('returns the array', async () => {
    stubFetch(async () => jsonResponse([{ id: '1' }, { id: '2' }]))
    expect(await getList('/api/athletes')).toHaveLength(2)
  })

  it('refuses a non-array rather than quietly yielding an empty list', async () => {
    // This is the exact shape of the original bug: a non-array answer became []
    // and the screen rendered its empty state, telling a coach with a full
    // roster that they had no athletes.
    stubFetch(async () => jsonResponse({ error: 'nope' }))
    await expect(getList('/api/athletes')).rejects.toBeInstanceOf(ApiError)
  })

  it('passes an empty array through — genuinely empty is not an error', async () => {
    stubFetch(async () => jsonResponse([]))
    expect(await getList('/api/athletes')).toEqual([])
  })
})

describe('sendJson', () => {
  it('sends the body as JSON and returns the answer', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'p1', status: 'active' }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await sendJson<{ status: string }>('PUT', '/api/programs/p1', { status: 'active' })
    expect(res.status).toBe('active')
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe('PUT')
    expect(init.body).toBe('{"status":"active"}')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('throws on a refusal, so a failed write cannot pass for a saved one', async () => {
    // The pattern this replaces was `await fetch(...)` with the answer ignored:
    // deleting a program navigated away whether or not anything was deleted.
    stubFetch(async () => jsonResponse({ error: 'Internal server error' }, 500))
    const err = await sendJson('DELETE', '/api/programs/p1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(500)
    // A 5xx body is about the server, not something to show the coach.
    expect((err as ApiError).message).not.toMatch(/Internal server error/)
  })

  it("shows the server's own reason for a 4xx", async () => {
    stubFetch(async () => jsonResponse({ error: 'No workout on source date' }, 400))
    await expect(sendJson('POST', '/api/programs/p1/move-day', {})).rejects.toThrow('No workout on source date')
  })

  it('resolves for an empty 204 instead of failing to parse it', async () => {
    stubFetch(async () => new Response(null, { status: 204 }))
    await expect(sendJson('DELETE', '/api/programs/p1')).resolves.toBeUndefined()
  })

  it('says nothing was changed when the server cannot be reached', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    const err = await sendJson('POST', '/api/programs', {}).catch((e: unknown) => e)
    expect(isOffline(err)).toBe(true)
    expect((err as ApiError).message).toMatch(/nothing was changed/)
  })
})
