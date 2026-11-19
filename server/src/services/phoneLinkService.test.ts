import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { configureSecureStore } from './secureStore.js'
import {
  claimPhoneClip,
  lanAddresses,
  phoneClip,
  phoneLinkStatus,
  startPhoneLink,
  stopPhoneLink,
} from './phoneLinkService.js'

// BP41 part b (D100, D104–D106): the phone link.

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

/** The phone's view of the link: the same URL, reached on this machine. */
const local = (url: string) => url.replace(/^http:\/\/[^/:]+/, 'http://127.0.0.1')

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
    expect(s.url).toMatch(/^http:\/\/192\.168\.1\.34:\d+\/p\/[0-9a-f]{32}$/)
    expect(s.qrSvg).toMatch(/^<svg/)
    const page = await fetch(local(s.url!))
    expect(page.status).toBe(200)
    expect(await page.text()).toMatch(/Record a set/)
    // Anything else — a guessed code, the app's own API — is not there.
    const port = new URL(s.url!).port
    for (const p of ['/p/' + '0'.repeat(32), '/api/athletes', '/', '/p']) {
      expect((await fetch(`http://127.0.0.1:${port}${p}`)).status).toBe(404)
    }
  })

  it('takes one clip, then closes (one clip per scan)', async () => {
    const s = await startPhoneLink({ addresses: ['192.168.1.34'] })
    const bytes = Buffer.alloc(300_000, 7)
    const sent = await fetch(local(s.url!) + '/clip?name=IMG_0042.MOV', { method: 'POST', body: bytes })
    expect(sent.status).toBe(200)
    expect(phoneLinkStatus().clip).toEqual({ name: 'IMG_0042.MOV', bytes: 300_000 })
    const clip = phoneClip()!
    expect(path.extname(clip.file)).toBe('.mov')
    expect(fs.readFileSync(clip.file).equals(bytes)).toBe(true)
    // A second clip on the same code is not accepted: the listener is gone.
    await expect(fetch(local(s.url!) + '/clip?name=b.mp4', { method: 'POST', body: bytes })).rejects.toThrow()
    // Opened in the analysis: deleted here, link ended.
    claimPhoneClip()
    expect(fs.existsSync(clip.file)).toBe(false)
    expect(phoneLinkStatus().active).toBe(false)
  })

  it('a strange file name is stored as .mp4, never as given', async () => {
    const s = await startPhoneLink({ addresses: ['192.168.1.34'] })
    await fetch(local(s.url!) + '/clip?name=' + encodeURIComponent('../../evil.exe'), { method: 'POST', body: Buffer.alloc(10, 1) })
    const clip = phoneClip()!
    expect(path.dirname(clip.file)).toBe(path.join(dir, 'phone-clips'))
    expect(path.extname(clip.file)).toBe('.mp4')
  })

  it('an empty upload is refused and the link stays open for another try', async () => {
    const s = await startPhoneLink({ addresses: ['192.168.1.34'] })
    const r = await fetch(local(s.url!) + '/clip?name=a.mp4', { method: 'POST', body: Buffer.alloc(0) })
    expect(r.status).toBe(400)
    expect(phoneLinkStatus()).toMatchObject({ active: true, clip: null })
    expect((await fetch(local(s.url!) + '/clip?name=a.mp4', { method: 'POST', body: Buffer.alloc(5, 1) })).status).toBe(200)
  })

  it('stopping closes the listener and deletes a clip nobody opened', async () => {
    const s = await startPhoneLink({ addresses: ['192.168.1.34'] })
    await fetch(local(s.url!) + '/clip?name=a.mp4', { method: 'POST', body: Buffer.alloc(5, 1) })
    const file = phoneClip()!.file
    stopPhoneLink()
    expect(fs.existsSync(file)).toBe(false)
    const again = await startPhoneLink({ addresses: ['192.168.1.34'] })
    expect(again.url).not.toBe(s.url) // a new code every time
    stopPhoneLink()
    await expect(fetch(local(again.url!))).rejects.toThrow()
  })

  it('opening the screen twice keeps the same code, so a QR already scanned still works', async () => {
    const a = await startPhoneLink({ addresses: ['192.168.1.34'] })
    const b = await startPhoneLink({ addresses: ['192.168.1.34'] })
    expect(b.url).toBe(a.url)
  })
})
