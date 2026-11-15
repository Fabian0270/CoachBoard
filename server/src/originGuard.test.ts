import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import http from 'http'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { createApp } from './app.js'
import { initializeDatabase, getDb } from './db.js'
import { rejectionReason } from './lib/originGuard.js'

// The requests a hostile web page can make against the embedded server, sent
// over real HTTP. Node's fetch refuses to set Host and Origin by hand, which is
// the whole point of these cases, so this uses http.request directly.

let server: Server
let port: number

beforeAll(async () => {
  await initializeDatabase(':memory:')
  server = createApp().listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

function send(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }))
      },
    )
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

const athleteCount = async () =>
  (await getDb().selectFrom('athletes').select('id').execute()).length

describe('requests from the app itself', () => {
  it('accepts a same-origin write', async () => {
    const res = await send(
      'POST',
      '/api/athletes',
      { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
      JSON.stringify({ name: 'Own Window' }),
    )
    expect(res.status).toBe(201)
  })

  it('accepts the dev renderer through the Vite proxy', async () => {
    // The proxy rewrites Host to the server but forwards the page's Origin.
    const res = await send('GET', '/api/athletes', {
      Host: `localhost:${port}`,
      Origin: 'http://localhost:3000',
      'Sec-Fetch-Site': 'same-origin',
    })
    expect(res.status).toBe(200)
  })

  it('accepts a top-level load of the app (no Origin, Sec-Fetch-Site: none)', async () => {
    const res = await send('GET', '/api/athletes', { 'Sec-Fetch-Site': 'none' })
    expect(res.status).toBe(200)
  })
})

describe('requests from another website', () => {
  it('refuses a cross-site form post and writes nothing', async () => {
    const before = await athleteCount()
    const res = await send(
      'POST',
      '/api/athletes',
      {
        Origin: 'https://evil.example',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Sec-Fetch-Site': 'cross-site',
      },
      'name=InjectedByWebsite',
    )
    expect(res.status).toBe(403)
    expect(await athleteCount()).toBe(before)
  })

  it('refuses the destructive Discord purge the audit reproduced', async () => {
    const res = await send(
      'POST',
      '/api/discord/clear-cache',
      { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
      '{"days":0}',
    )
    expect(res.status).toBe(403)
  })

  it('refuses a DNS-rebinding read (foreign Host header)', async () => {
    const res = await send('GET', '/api/backup/info', { Host: `evil.example:${port}` })
    expect(res.status).toBe(403)
    expect(res.body).not.toContain('databasePath')
  })

  it('refuses an embedded GET with no Origin (an <img> or <video> on a foreign page)', async () => {
    const res = await send('GET', '/api/athletes', { 'Sec-Fetch-Site': 'cross-site' })
    expect(res.status).toBe(403)
  })

  it('refuses another web app on a different localhost port', async () => {
    // Every localhost port is the same SITE, so this arrives as same-site.
    const res = await send('POST', '/api/discord/sync', {
      Origin: 'http://localhost:8080',
      'Sec-Fetch-Site': 'same-site',
    })
    expect(res.status).toBe(403)
  })
})

describe('defence in depth', () => {
  it('no longer parses urlencoded bodies, even same-origin', async () => {
    const res = await send(
      'POST',
      '/api/athletes',
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      'name=FormEncoded',
    )
    expect(res.status).toBe(400)
  })

  it('sends no CORS grant and forbids framing', async () => {
    const res = await send('OPTIONS', '/api/athletes/x', {
      Origin: `http://127.0.0.1:${port}`,
      'Access-Control-Request-Method': 'DELETE',
    })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })
})

describe('rejectionReason', () => {
  it.each([
    [{ host: 'localhost:3001' }, null],
    [{ host: '127.0.0.1:3001' }, null],
    [{ host: '[::1]:3001' }, null],
    [{ host: '127.0.0.1:3001', origin: 'http://127.0.0.1:3001' }, null],
    [{ host: 'localhost:3001', origin: 'http://127.0.0.1:3001' }, 'foreign origin http://127.0.0.1:3001'],
    [{ host: '127.0.0.1:3001', origin: 'null' }, 'foreign origin null'],
    [{ host: '127.0.0.1.evil.example' }, 'foreign host 127.0.0.1.evil.example'],
    [{}, 'foreign host (none)'],
  ])('%j -> %s', (headers, expected) => {
    expect(rejectionReason(headers)).toBe(expected)
  })
})
