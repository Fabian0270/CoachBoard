import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import vm from 'vm'
import { configureSecureStore } from './secureStore.js'
import {
  CHUNK_BYTES,
  claimPhoneClip,
  lanAddresses,
  phoneClip,
  phoneLinkStatus,
  phonePage,
  pieceAad,
  pieceNonce,
  startPhoneLink,
  stopPhoneLink,
} from './phoneLinkService.js'
import { PHONE_CRYPTO_JS, PHONE_CRYPTO_LICENSE } from './phoneCrypto.generated.js'

// BP41 part b (D100, D104–D106): the phone link. D127: the lift comes from the
// phone. D128: the clip is encrypted with a key that never crosses the network,
// and only the device that opened the page may send.

vi.spyOn(console, 'log').mockImplementation(() => {})

let dir = ''
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coachboard-phone-'))
  configureSecureStore({ userDataDir: dir })
})
afterEach(() => { stopPhoneLink() })
afterAll(() => {
  configureSecureStore({ userDataDir: null })
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* Windows lock */ }
})

/** The phone's view of the link: the same URL, reached on this machine, without the '#' part (never sent). */
const local = (url: string) => url.replace(/^http:\/\/[^/:]+/, 'http://127.0.0.1').replace(/#.*$/, '')
const keyOf = (url: string) => Buffer.from(new URL(url).hash.replace(/^#k=/, ''), 'base64url')

/** A request from a given loopback address — 127.0.0.1 is "the phone", 127.0.0.2 "someone else". */
function request(url: string, opts: { method?: string; body?: Buffer; from?: string } = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method ?? 'GET', localAddress: opts.from ?? '127.0.0.1' }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (c: Buffer) => parts.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

/** Seals one piece the way the phone page does. */
function seal(key: Buffer, id: Buffer, index: number, last: boolean, lift: string, name: string, plain: Buffer): Buffer {
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, pieceNonce(id, index, last), { authTagLength: 16 })
  cipher.setAAD(pieceAad(lift, name), { plaintextLength: plain.length })
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
}

/** Opens the page as the phone, then sends `bytes` in encrypted pieces. Returns each piece's reply. */
async function sendClip(url: string, bytes: Buffer, o: { lift?: string; name?: string; key?: Buffer; from?: string; open?: boolean } = {}) {
  const lift = o.lift ?? 'back-squat'
  const name = o.name ?? 'IMG_0042.MOV'
  const key = o.key ?? keyOf(url)
  if (o.open !== false) await request(local(url), { from: o.from })
  const id = crypto.randomBytes(8)
  const replies: { status: number; text: string }[] = []
  const count = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES))
  for (let i = 0; i < count; i++) {
    const last = i === count - 1
    const body = seal(key, id, i, last, lift, name, bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES))
    const q = `?u=${id.toString('hex')}&i=${i}&last=${last ? 1 : 0}&lift=${encodeURIComponent(lift)}&name=${encodeURIComponent(name)}`
    const r = await request(local(url) + '/clip' + q, { method: 'POST', body, from: o.from })
    replies.push(r)
    if (r.status !== 200) break
  }
  return replies
}

describe('which address the phone is shown', () => {
  it('private Wi-Fi first, virtual adapters last, never loopback or link-local', () => {
    expect(lanAddresses({
      'vEthernet (WSL)': [{ address: '172.20.48.1', family: 'IPv4', internal: false }],
      Ethernet: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
      'Wi-Fi': [{ address: '192.168.1.34', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
      'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      Other: [{ address: '169.254.10.2', family: 'IPv4', internal: false }, { address: '8.8.8.8', family: 'IPv4', internal: false }],
    })).toEqual(['192.168.1.34', '192.168.1.20', '172.20.48.1'])
  })

  it('no network a phone could reach: says so', async () => {
    await expect(startPhoneLink({ addresses: [] })).rejects.toThrow(/isn't on a network a phone can reach/)
    expect(phoneLinkStatus().active).toBe(false)
  })
})

describe('the phone link', () => {
  it('serves the phone page only behind the code in the QR', async () => {
    const s = await startPhoneLink({ addresses: ['192.168.1.34'] })
    // The code in the path, and the key after '#' (D128) — 256 bits, a new one every time.
    expect(s.url).toMatch(/^http:\/\/192\.168\.1\.34:\d+\/p\/[0-9a-f]{32}#k=[A-Za-z0-9_-]{43}$/)
    expect(keyOf(s.url!)).toHaveLength(32)
    expect(s.qrSvg).toMatch(/^<svg/)
    const page = await request(local(s.url!))
    expect(page.status).toBe(200)
    expect(page.text).toMatch(/Record a set/)
    // Anything else — a guessed code, the app's own API — is not there.
    const port = new URL(s.url!).port
    for (const p of ['/p/' + '0'.repeat(32), '/p/' + 'g'.repeat(32), '/api/athletes', '/', '/p']) {
      expect((await request(`http://127.0.0.1:${port}${p}`)).status).toBe(404)
    }
  })

  it('the phone page asks the lift first (D127): every lift, and filming locked until one is tapped', () => {
    const html = phonePage()
    for (const id of ['back-squat', 'bench-press', 'deadlift-conventional', 'other']) expect(html).toContain(`data-lift="${id}"`)
    expect(html).toMatch(/<input id="cam"[^>]*disabled>/)
    expect(html).toMatch(/<input id="lib"[^>]*disabled>/)
  })

  it('takes one encrypted clip, then closes (one clip per scan)', async () => {
    const s = await startPhoneLink({ addresses: ['192.168.1.34'] })
    const bytes = crypto.randomBytes(300_000)
    const replies = await sendClip(s.url!, bytes)
    expect(replies.map((r) => r.status)).toEqual([200])
    expect(phoneLinkStatus().clip).toEqual({ name: 'IMG_0042.MOV', bytes: 300_000, lift: 'back-squat' })
    const clip = phoneClip()!
    expect(path.extname(clip.file)).toBe('.mov')
    expect(fs.readFileSync(clip.file).equals(bytes)).toBe(true)
    // A second clip on the same code is not accepted: the listener is gone.
    await expect(sendClip(s.url!, bytes, { open: false })).rejects.toThrow()
    // Opened in the analysis: deleted here, link ended.
    claimPhoneClip()
    expect(fs.existsSync(clip.file)).toBe(false)
    expect(phoneLinkStatus().active).toBe(false)
  })

  it('a clip bigger than one piece arrives whole, in order', async () => {
    const s = await startPhoneLink({ addresses: ['192.168.1.34'] })
    const bytes = crypto.randomBytes(CHUNK_BYTES * 2 + 12345)
    const replies = await sendClip(s.url!, bytes, { lift: 'bench-press', name: 'set.mp4' })
    expect(replies.map((r) => r.status)).toEqual([200, 200, 200])
    expect(fs.readFileSync(phoneClip()!.file).equals(bytes)).toBe(true)
    expect(phoneClip()!.lift).toBe('bench-press')
  })

  it('what crosses the Wi-Fi is not the footage', async () => {
    const s = await startPhoneLink({ addresses: ['192.168.1.34'] })
    const bytes = Buffer.alloc(50_000, 'LIFT FOOTAGE ')
    const body = seal(keyOf(s.url!), crypto.randomBytes(8), 0, true, 'back-squat', 'a.mp4', bytes)
    expect(body.includes(Buffer.from('LIFT FOOTAGE'))).toBe(false)
  })

  it('someone who read the code off the Wi-Fi, but not the key, cannot send a clip', async () => {
    const s = await startPhoneLink({ addresses: ['192.168.1.34'] })
    const replies = await sendClip(s.url!, crypto.randomBytes(1000), { key: crypto.randomBytes(32) })
    expect(replies[0].status).toBe(400)
    expect(JSON.parse(replies[0].text).error).toMatch(/didn't come from the phone that scanned this code/)
    expect(phoneLinkStatus()).toMatchObject({ active: true, clip: null, receiving: null })
    await vi.waitFor(() => expect(fs.readdirSync(path.join(dir, 'phone-clips'))).toEqual([]))
    // The real phone still can.
    expect((await sendClip(s.url!, crypto.randomBytes(1000))).map((r) => r.status)).toEqual([200])
  })

  it('the lift or name changed on the way is refused (they are sealed into every piece)', async () => {
    const s = await startPhoneLink({ addresses: ['192.168.1.34'] })
    await request(local(s.url!))
    const id = crypto.randomBytes(8)
    const body = seal(keyOf(s.url!), id, 0, true, 'bench-press', 'a.mp4', crypto.randomBytes(1000))
    const r = await request(local(s.url!) + `/clip?u=${id.toString('hex')}&i=0&last=1&lift=back-squat&name=a.mp4`, { method: 'POST', body })
    expect(r.status).toBe(400)
    expect(phoneLinkStatus().clip).toBeNull()
  })

  it('a tampered piece, or one out of order, drops the clip part-way in', async () => {
    const s = await startPhoneLink({ addresses: ['192.168.1.34'] })
    const key = keyOf(s.url!)
    await request(local(s.url!))
    const id = crypto.randomBytes(8)
    const q = (i: number, last: boolean) => `${local(s.url!)}/clip?u=${id.toString('hex')}&i=${i}&last=${last ? 1 : 0}&lift=back-squat&name=a.mp4`
    const first = seal(key, id, 0, false, 'back-squat', 'a.mp4', crypto.randomBytes(CHUNK_BYTES))
    expect((await request(q(0, false), { method: 'POST', body: first })).status).toBe(200)
    expect(phoneLinkStatus().receiving).toBe(CHUNK_BYTES)
    // Piece 2 before piece 1.
    const skipped = seal(key, id, 2, true, 'back-squat', 'a.mp4', crypto.randomBytes(10))
    expect((await request(q(2, true), { method: 'POST', body: skipped })).status).toBe(400)
    expect(phoneLinkStatus()).toMatchObject({ receiving: null, clip: null })
    // A flipped bit.
    expect((await request(q(0, false), { method: 'POST', body: first })).status).toBe(200)
    const bad = seal(key, id, 1, true, 'back-squat', 'a.mp4', crypto.randomBytes(10))
    bad[3] ^= 1
    expect((await request(q(1, true), { method: 'POST', body: bad })).status).toBe(400)
    expect(phoneLinkStatus()).toMatchObject({ receiving: null, clip: null })
    await vi.waitFor(() => expect(fs.readdirSync(path.join(dir, 'phone-clips'))).toEqual([]))
  })

  it('only the device that opened the page may send, even with the code and key (D128)', async () => {
    const s = await startPhoneLink({ addresses: ['192.168.1.34'] })
    // Nobody has opened the page yet: a send straight away is refused.
    expect((await sendClip(s.url!, crypto.randomBytes(100), { open: false }))[0].status).toBe(403)
    // The phone opens it; someone else then can't open it or send.
    expect((await request(local(s.url!))).status).toBe(200)
    const other = await request(local(s.url!), { from: '127.0.0.2' })
    expect(other.status).toBe(403)
    expect(other.text).toMatch(/already open on another phone/)
    expect((await sendClip(s.url!, crypto.randomBytes(100), { from: '127.0.0.2', open: false }))[0].status).toBe(403)
    expect((await sendClip(s.url!, crypto.randomBytes(100))).map((r) => r.status)).toEqual([200])
  })

  it('a clip without a lift, or with one CoachBoard does not know, is refused and the link stays open', async () => {
    const s = await startPhoneLink({ addresses: ['192.168.1.34'] })
    await request(local(s.url!))
    for (const q of ['?u=0011223344556677&i=0&last=1&name=a.mp4', '?u=0011223344556677&i=0&last=1&lift=curl&name=a.mp4']) {
      const r = await request(local(s.url!) + '/clip' + q, { method: 'POST', body: Buffer.alloc(40, 1) })
      expect(r.status).toBe(400)
      expect(JSON.parse(r.text)).toEqual({ error: 'Pick the lift first.' })
    }
    expect(phoneLinkStatus()).toMatchObject({ active: true, clip: null })
    expect((await sendClip(s.url!, crypto.randomBytes(5), { lift: 'bench-press' })).map((r) => r.status)).toEqual([200])
    expect(phoneLinkStatus().clip?.lift).toBe('bench-press')
  })

  it('a strange file name is stored as .mp4, never as given', async () => {
    const s = await startPhoneLink({ addresses: ['192.168.1.34'] })
    await sendClip(s.url!, crypto.randomBytes(10), { name: '../../evil.exe' })
    const clip = phoneClip()!
    expect(path.dirname(clip.file)).toBe(path.join(dir, 'phone-clips'))
    expect(path.extname(clip.file)).toBe('.mp4')
  })

  it('an empty upload is refused and the link stays open for another try', async () => {
    const s = await startPhoneLink({ addresses: ['192.168.1.34'] })
    expect((await sendClip(s.url!, Buffer.alloc(0)))[0].status).toBe(400)
    expect(phoneLinkStatus()).toMatchObject({ active: true, clip: null })
    expect((await sendClip(s.url!, crypto.randomBytes(5))).map((r) => r.status)).toEqual([200])
  })

  it('stopping closes the listener and deletes a clip nobody opened', async () => {
    const s = await startPhoneLink({ addresses: ['192.168.1.34'] })
    await sendClip(s.url!, crypto.randomBytes(5))
    const file = phoneClip()!.file
    stopPhoneLink()
    expect(fs.existsSync(file)).toBe(false)
    const again = await startPhoneLink({ addresses: ['192.168.1.34'] })
    expect(local(again.url!)).not.toBe(local(s.url!)) // a new code every time
    expect(keyOf(again.url!).equals(keyOf(s.url!))).toBe(false) // and a new key
    stopPhoneLink()
    await expect(request(local(again.url!))).rejects.toThrow()
  })

  it('opening the screen twice keeps the same code, so a QR already scanned still works', async () => {
    const a = await startPhoneLink({ addresses: ['192.168.1.34'] })
    const b = await startPhoneLink({ addresses: ['192.168.1.34'] })
    expect(b.url).toBe(a.url)
  })
})

describe("the phone page's encryption (D128)", () => {
  it("what the page's bundled cipher seals, Node's own decrypts — the same pieces the server takes", async () => {
    // Run as the page runs it, in a realm of its own (as in the phone's browser).
    const page = vm.createContext({})
    vm.runInContext('var self = globalThis;', page)
    vm.runInContext(PHONE_CRYPTO_JS, page)
    type Seal = (k: Uint8Array, n: Uint8Array, a: Uint8Array, d: Uint8Array) => Uint8Array
    const cbSeal = vm.runInContext('self.cbSeal', page) as Seal
    const PageBytes = vm.runInContext('Uint8Array', page) as Uint8ArrayConstructor
    const bytes = (b: Buffer) => new PageBytes(b)
    const s = await startPhoneLink({ addresses: ['192.168.1.34'] })
    await request(local(s.url!))
    const key = keyOf(s.url!)
    const id = crypto.randomBytes(8)
    const plain = crypto.randomBytes(1_000_003)
    const sealed = Buffer.from(cbSeal(bytes(key), bytes(pieceNonce(id, 0, true)), bytes(pieceAad('deadlift-sumo', 'clip.mov')), bytes(plain)))
    expect(sealed.equals(seal(key, id, 0, true, 'deadlift-sumo', 'clip.mov', plain))).toBe(true)
    const r = await request(local(s.url!) + `/clip?u=${id.toString('hex')}&i=0&last=1&lift=deadlift-sumo&name=clip.mov`, { method: 'POST', body: sealed })
    expect(r.status).toBe(200)
    expect(fs.readFileSync(phoneClip()!.file).equals(plain)).toBe(true)
  })

  it("decrypts without Node's own chacha20-poly1305, which Electron's BoringSSL doesn't have", async () => {
    const unknown = () => { throw new Error('Unknown cipher') }
    const spy = vi.spyOn(crypto, 'createDecipheriv').mockImplementation(unknown as never)
    try {
      const s = await startPhoneLink({ addresses: ['192.168.1.34'] })
      const bytes = crypto.randomBytes(5000)
      expect((await sendClip(s.url!, bytes)).map((r) => r.status)).toEqual([200])
      expect(fs.readFileSync(phoneClip()!.file).equals(bytes)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('the bundled cipher is what the build script makes from the installed @noble/ciphers', async () => {
    const script = path.resolve(__dirname, '../../scripts/build-phone-crypto.mjs')
    const { phoneCryptoSource, OUT } = await import(/* @vite-ignore */ new URL(`file:///${script.replace(/\\/g, '/')}`).href)
    expect(fs.readFileSync(OUT, 'utf8')).toBe(await phoneCryptoSource())
  })

  it('the page carries the cipher inline with its MIT notice, and nothing in either can end the <script> or the comment early', () => {
    expect(PHONE_CRYPTO_JS).not.toMatch(/<\/script/i)
    expect(PHONE_CRYPTO_LICENSE).not.toMatch(/<\/script|\*\//i)
    expect(PHONE_CRYPTO_LICENSE).toMatch(/MIT License[\s\S]*Paul Miller/)
    const html = phonePage()
    expect(html).toContain(PHONE_CRYPTO_JS)
    expect(html).toContain(PHONE_CRYPTO_LICENSE)
  })
})
