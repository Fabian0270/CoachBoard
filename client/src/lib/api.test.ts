import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApiError, getJson, getList, isOffline } from './api'

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
    const err = await getJson('/api/athletes').catch((e) => e)
    expect(isOffline(err)).toBe(true)
    // The server is embedded in the app, so this is "not started yet" rather
    // than "you have no internet" — the message must not blame the network.
    expect(err.message).not.toMatch(/internet|offline/i)
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
