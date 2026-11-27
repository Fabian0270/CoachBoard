import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import QRCode from 'qrcode'
// Not Node's own cipher: Electron's Node is built on BoringSSL, which has no
// chacha20-poly1305 (createDecipheriv says "Unknown cipher" in the packaged app).
import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { VBT_LIFTS, isVbtLift, type VbtLift } from 'coachboard-shared/vbt'
import { userDataDir } from './secureStore.js'
import { extensionFor } from './analysisVideoStore.js'
import { NOBLE_CIPHERS_VERSION, PHONE_CRYPTO_JS, PHONE_CRYPTO_LICENSE } from './phoneCrypto.generated.js'
import { log } from '../lib/logger.js'

// ---------------------------------------------------------------------------
// The phone link (BP41 part b, D100, D104–D106, D128).
//
// For coaching in person with a phone: CoachBoard shows a QR code, the phone
// opens a small page from it, the phone's OWN camera app films the set, and
// the clip comes over the Wi-Fi straight into the analysis on the computer.
// Not a live stream: a phone browser only gives a web page the camera over
// HTTPS, which a local app on gym Wi-Fi cannot offer without warnings — but a
// plain file upload needs no such thing, and the phone's camera app films
// better than a browser would anyway.
//
// The app's real server listens on this computer only (127.0.0.1) and stays
// that way. This is a SEPARATE listener that exists only while the coach has
// the phone screen open. It answers exactly two requests, both behind a
// one-time code in the QR: the phone page, and the upload of one clip. After
// that one clip it closes (one clip per scan, D104). Nothing else of
// CoachBoard is reachable from the network.
//
// Plain HTTP can be read by anyone on the same Wi-Fi, so (D128):
//  - The QR also carries a key, after '#'. Browsers never send that part of a
//    link, so it never crosses the network. The phone encrypts the clip with
//    it (ChaCha20-Poly1305, in 4 MB pieces) and this side decrypts and checks
//    every piece: someone who reads the Wi-Fi sees neither the footage nor can
//    send a clip of their own. The lift and file name are bound into each
//    piece, so they can't be swapped on the way either.
//  - The first device to open the page is the only one that may send; any
//    other is turned away, even with the right code.
// ---------------------------------------------------------------------------

/** D106: anything a phone films is accepted, up to this. */
export const MAX_CLIP_BYTES = 2 * 1024 ** 3

/** Plaintext bytes in each encrypted piece the phone sends. */
export const CHUNK_BYTES = 4 * 1024 * 1024
const TAG_BYTES = 16

/** Bound into every piece with the lift and name (the AEAD's associated data). */
export const AAD_PREFIX = 'coachboard-phone-1'
export const MAX_NAME_CHARS = 200

/**
 * The link closes itself this long after the screen opened if no phone opens
 * it — and, once one has, this long after that, whatever is going on: a hard
 * cap that also ends a clip part-way in (D130).
 */
const IDLE_MS = 30 * 60 * 1000
/** Until a phone opens the page, the code and key change this often (D130)… */
export const ROTATE_MS = 45 * 1000
/** …and the one just replaced still opens the page for this long, for a scan made right at the switch. */
export const GRACE_MS = 30 * 1000
/** A clip that stops arriving part-way is dropped after this long. */
const STALL_MS = 2 * 60 * 1000

export interface PhoneLinkStatus {
  active: boolean
  /** This visit's link, for the screen to close its own and no other. Not the code; never shown to the phone. */
  id: string | null
  /** When the code changes next (ms since epoch), while no phone has opened the page. */
  rotatesAt: number | null
  /** How often it changes, so the screen's countdown can roll over by itself without waiting for the next status. */
  rotateEveryMs: number | null
  /** The address of the phone that opened the page, once one has (D130). */
  phone: string | null
  /** Carries the key after '#' (D128): shown only on this computer, as the QR and the typed fallback. */
  url: string | null
  /** Other addresses this computer has, for when the first does not reach the phone. */
  otherUrls: string[]
  qrSvg: string | null
  /** Bytes received so far while a clip is arriving. */
  receiving: number | null
  /** `lift` is the one tapped on the phone before filming (D127): the analysis goes by it. */
  clip: { name: string; bytes: number; lift: VbtLift } | null
  /** Why the link closed on its own, if it did. */
  closedBecause: string | null
}

interface Upload {
  id: Buffer
  next: number
  lift: VbtLift
  name: string
  file: string
  handle: fs.promises.FileHandle
  bytes: number
  busy: boolean
  /** Set between pieces: drops the clip if the next one never comes. */
  stall?: NodeJS.Timeout
}

interface Code {
  token: Buffer
  key: Buffer
  urls: string[]
  qrSvg: string
}

interface Link extends Code {
  id: string
  idleMs: number
  addresses: string[]
  server: http.Server
  port: number
  /** The code just replaced, still good for opening the page until `until`. */
  previous: (Code & { until: number }) | null
  rotate: NodeJS.Timeout | null
  rotatesAt: number | null
  rotateMs: number
  /** The device that opened the page first: the only one allowed to send (D128). */
  phoneAddr: string | null
  upload: Upload | null
  clip: { file: string; name: string; bytes: number; lift: VbtLift } | null
  idle: NodeJS.Timeout
  /** The listener is closed as soon as the one clip arrives; the link lives on until it is opened. */
  open: boolean
}

let link: Link | null = null
let closedBecause: string | null = null

const clipDir = (): string => {
  const base = userDataDir()
  if (!base) throw new Error('The data folder is not set up')
  return path.join(base, 'phone-clips')
}

type Iface = { address: string; family: string | number; internal: boolean }

/**
 * The addresses a phone on the same Wi-Fi could reach, best guess first:
 * private IPv4 only, never loopback or link-local, and virtual adapters
 * (Hyper-V, WSL, VirtualBox, VMware, VPNs) last — they are on the list Windows
 * hands back but no phone can reach them.
 */
export function lanAddresses(ifaces: Record<string, Iface[] | undefined>): string[] {
  const isPrivate = (a: string) =>
    /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a)
  const virtual = /vethernet|wsl|hyper-v|virtualbox|vmware|vbox|docker|tailscale|zerotier|vpn|loopback|bluetooth/i
  const found: { address: string; rank: number }[] = []
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      const v4 = i.family === 'IPv4' || i.family === 4
      if (!v4 || i.internal || !isPrivate(i.address)) continue
      const rank = (virtual.test(name) ? 2 : 0) + (/wi-?fi|wlan|wireless/i.test(name) ? 0 : 1)
      found.push({ address: i.address, rank })
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map((f) => f.address).filter((a, i, all) => all.indexOf(a) === i)
}

export function phoneLinkStatus(): PhoneLinkStatus {
  return {
    active: !!link,
    id: link?.id ?? null,
    rotatesAt: link && !link.phoneAddr ? link.rotatesAt : null,
    rotateEveryMs: link && !link.phoneAddr && link.rotatesAt ? link.rotateMs : null,
    phone: link?.phoneAddr ? link.phoneAddr.replace(/^::ffff:/, '') : null,
    url: link?.urls[0] ?? null,
    otherUrls: link?.urls.slice(1) ?? [],
    qrSvg: link?.qrSvg ?? null,
    receiving: link?.upload ? link.upload.bytes : null,
    clip: link?.clip ? { name: link.clip.name, bytes: link.clip.bytes, lift: link.clip.lift } : null,
    closedBecause: link ? null : closedBecause,
  }
}

/** Removes clips that never reached the analysis (the app closed mid-way). */
function sweepClips(keep?: string): void {
  try {
    const dir = clipDir()
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const p = path.join(dir, f)
      if (p !== keep) fs.rmSync(p, { force: true })
    }
  } catch { /* nothing to sweep */ }
}

/** Drops a clip that was part-way in: its file goes, and the link waits for another try. */
function dropUpload(current: Link, why: string): void {
  const up = current.upload
  if (!up) return
  current.upload = null
  clearTimeout(up.stall)
  void up.handle.close().catch(() => {}).finally(() => fs.rmSync(up.file, { force: true }))
  log(`Phone clip not received: ${why}`)
  // The 30-minute cap keeps running: a failed clip does not buy the phone more time (D130).
}

function closeServer(why: string | null): void {
  if (!link) return
  clearTimeout(link.idle)
  stopRotating(link)
  if (!link.open) return
  link.open = false
  link.server.close()
  // Keep-alive sockets would otherwise hold the port open until they time out.
  link.server.closeAllConnections?.()
  log(`Phone link closed${why ? `: ${why}` : ''}`)
}

/**
 * Stop the link. A clip that arrived but was never opened is deleted. Given an
 * id, only that visit's link is stopped: the screen closing its own link must
 * never close the next visit's, if the two cross on the way.
 */
export function stopPhoneLink(id?: string): PhoneLinkStatus {
  if (link && id !== undefined && id !== link.id) return phoneLinkStatus()
  if (link) {
    dropUpload(link, 'the link was closed')
    closeServer(null)
    if (link.clip) fs.rmSync(link.clip.file, { force: true })
    link = null
  }
  closedBecause = null
  return phoneLinkStatus()
}

/** The received clip's file, for the app's own server to hand to the analysis. */
export function phoneClip(): { file: string; name: string; bytes: number; lift: VbtLift } | null {
  return link?.clip ?? null
}

/** The analysis has the clip: delete it here and end the link. */
export function claimPhoneClip(): void {
  stopPhoneLink()
}

/**
 * Start a new link: a new code and key every time the phone screen opens
 * (Fabian, 2026-11-27). Any older one is closed first — after a window reload
 * the last screen never said goodbye, and its listener must not linger.
 */
export async function startPhoneLink(opts: { addresses?: string[]; rotateMs?: number; graceMs?: number; idleMs?: number } = {}): Promise<PhoneLinkStatus> {
  stopPhoneLink()
  sweepClips()
  const addresses = opts.addresses ?? lanAddresses(os.networkInterfaces())
  if (addresses.length === 0) {
    throw new PhoneLinkError("This computer isn't on a network a phone can reach. Connect it to the gym's Wi-Fi (or the same network as your phone), then try again.")
  }
  const server = http.createServer((req, res) => handle(req, res))
  // Every address, not one: the phone may reach this computer through any of
  // them. The code in the path is what keeps everything else out.
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', () => resolve((server.address() as { port: number }).port))
  })
  const code = await newCode(addresses, port)
  const rotateMs = opts.rotateMs ?? ROTATE_MS
  const graceMs = opts.graceMs ?? GRACE_MS
  const idleMs = opts.idleMs ?? IDLE_MS
  link = {
    ...code, id: crypto.randomUUID(), idleMs, addresses, server, port, previous: null, rotate: null, rotatesAt: null, rotateMs,
    phoneAddr: null, upload: null, clip: null, idle: setTimeout(() => expire(), idleMs), open: true,
  }
  link.idle.unref?.()
  startRotating(link, rotateMs, graceMs)
  closedBecause = null
  log(`Phone link open on port ${port} (${addresses.join(', ')})`)
  return phoneLinkStatus()
}

/** A fresh code and key, and the QR that carries them. */
async function newCode(addresses: string[], port: number): Promise<Code> {
  const token = crypto.randomBytes(16)
  const key = crypto.randomBytes(32)
  const urls = addresses.map((a) => `http://${a}:${port}/p/${token.toString('hex')}#k=${key.toString('base64url')}`)
  const qrSvg = await QRCode.toString(urls[0], { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
  return { token, key, urls, qrSvg }
}

/**
 * Until a phone opens the page, a new code every `rotateMs` (D130): a photo of
 * the screen goes stale within minutes. The code just replaced still opens the
 * page for `graceMs`, so a scan made right at the switch still works.
 */
function startRotating(current: Link, rotateMs: number, graceMs: number): void {
  current.rotatesAt = Date.now() + rotateMs
  current.rotate = setInterval(() => {
    void (async () => {
      if (link !== current || current.phoneAddr || !current.open) return
      const next = await newCode(current.addresses, current.port)
      if (link !== current || current.phoneAddr || !current.open) return
      current.previous = { token: current.token, key: current.key, urls: current.urls, qrSvg: current.qrSvg, until: Date.now() + graceMs }
      Object.assign(current, next)
      current.rotatesAt = Date.now() + rotateMs
    })()
  }, rotateMs)
  current.rotate.unref?.()
}

function stopRotating(current: Link): void {
  if (current.rotate) clearInterval(current.rotate)
  current.rotate = null
  current.rotatesAt = null
}

/** The 30 minutes are up: closed even with a clip part-way in (D130), which is dropped. */
function expire(): void {
  if (!link || link.clip) return
  const connected = !!link.phoneAddr
  dropUpload(link, 'the 30 minutes ran out')
  closeServer(connected ? '30 minutes since the phone connected' : 'no phone in 30 minutes')
  link = null
  closedBecause = connected
    ? 'The phone link closed 30 minutes after the phone connected. Start it again to send a clip.'
    : 'The phone link closed after 30 minutes with no phone connected. Start it again to send a clip.'
}

export class PhoneLinkError extends Error {}

/** The code in the path, compared in constant time. */
function tokenMatches(token: Buffer, given: string | undefined): boolean {
  if (!given || !/^[0-9a-f]{32}$/.test(given)) return false
  return crypto.timingSafeEqual(Buffer.from(given, 'hex'), token)
}

const OTHER_PHONE = 'This link is already open on another phone. On the computer, go back and open Send from my phone again for a new code.'

/** Only the two routes; anything else, or the wrong code, is a plain 404. */
function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const current = link
  const url = new URL(req.url ?? '/', 'http://phone')
  const parts = url.pathname.split('/').filter(Boolean) // ['p', token] or ['p', token, 'clip']
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  const isCurrent = !!current && parts[0] === 'p' && tokenMatches(current.token, parts[1])
  // The code just rotated out still opens the page for a moment, until a phone holds the link (D130).
  const prev = current?.previous
  const isPrevious = !isCurrent && !!current && !current.phoneAddr && !!prev && Date.now() < prev.until && parts[0] === 'p' && tokenMatches(prev.token, parts[1])
  if (!current || (!isCurrent && !isPrevious)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
    req.resume()
    return
  }
  const from = req.socket.remoteAddress ?? ''
  if (req.method === 'GET' && parts.length === 2) {
    // The first device to open the page holds the link (D128): the code it
    // came with is the only one from now on, and the codes stop changing.
    if (!current.phoneAddr) {
      current.phoneAddr = from
      if (isPrevious && prev) Object.assign(current, { token: prev.token, key: prev.key, urls: prev.urls, qrSvg: prev.qrSvg })
      current.previous = null
      stopRotating(current)
      // 30 minutes from the scan, not from when the screen opened — and only
      // once: nothing after this restarts the clock (D130).
      clearTimeout(current.idle)
      current.idle = setTimeout(() => expire(), current.idleMs)
      current.idle.unref?.()
      log('Phone link opened on a phone')
    }
    if (current.phoneAddr !== from) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end(OTHER_PHONE)
      return
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:",
    })
    res.end(phonePage())
    return
  }
  if (req.method === 'POST' && parts.length === 3 && parts[2] === 'clip') {
    void receive(current, url, from, req, res)
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
  req.resume()
}

/** The 12-byte nonce of piece `index`: the upload's random id, then the index, top bit set on the last. */
export function pieceNonce(id: Buffer, index: number, last: boolean): Buffer {
  const nonce = Buffer.alloc(12)
  id.copy(nonce, 0, 0, 8)
  nonce.writeUInt32BE(((index & 0x7fffffff) | (last ? 0x80000000 : 0)) >>> 0, 8)
  return nonce
}

export function pieceAad(lift: string, name: string): Buffer {
  return Buffer.from(`${AAD_PREFIX}\n${lift}\n${name}`, 'utf8')
}

/** The body of one request, refused past `limit` bytes. */
function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) { resolve(null); req.destroy(); return }
      parts.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('The phone stopped sending.')))
  })
}

/**
 * One encrypted piece of the clip: `?u=<upload id>&i=<index>&last=0|1&lift=&name=`.
 * Pieces arrive in order; any piece that does not decrypt with the key from the
 * QR drops the whole clip.
 */
async function receive(current: Link, url: URL, from: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const reply = (status: number, message: string, extra: Record<string, unknown> = {}) => {
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(status === 200 ? { ok: true, ...extra } : { error: message }))
  }
  const refuse = (status: number, message: string) => { reply(status, message); req.resume() }
  // Only the phone that opened the page (D128).
  if (!current.phoneAddr || current.phoneAddr !== from) { refuse(403, OTHER_PHONE); return }
  if (current.clip) { refuse(409, 'A clip is already on its way. Scan the code again for the next set.'); return }

  const q = url.searchParams
  const idHex = q.get('u') ?? ''
  const index = Number(q.get('i'))
  const last = q.get('last') === '1'
  const lift = q.get('lift')
  const name = q.get('name') ?? ''
  // D127: the lift is picked on the phone before filming, and the analysis goes by it.
  if (!isVbtLift(lift)) { refuse(400, 'Pick the lift first.'); return }
  if (!/^[0-9a-f]{16}$/.test(idHex) || !Number.isInteger(index) || index < 0 || index > 0x7fffffff || !name || name.length > MAX_NAME_CHARS) {
    refuse(400, 'That did not come from the CoachBoard page. Scan the code again.')
    return
  }
  const declared = Number(req.headers['content-length'] ?? NaN)
  if (Number.isFinite(declared) && declared > CHUNK_BYTES + TAG_BYTES) { refuse(413, 'That piece is too big.'); return }

  const id = Buffer.from(idHex, 'hex')
  let up = current.upload
  if (up?.busy) { refuse(409, 'A clip is already on its way. Scan the code again for the next set.'); return }
  if (index === 0) {
    // A fresh start from the phone (a retry after a failure) replaces a clip part-way in.
    if (up) dropUpload(current, 'the phone started again')
    fs.mkdirSync(clipDir(), { recursive: true })
    const file = path.join(clipDir(), `${crypto.randomUUID()}${extensionFor(name)}`)
    up = { id, next: 0, lift, name, file, handle: await fs.promises.open(file, 'w'), bytes: 0, busy: false }
    if (link !== current || current.upload) { await up.handle.close(); fs.rmSync(file, { force: true }); refuse(409, 'The link was closed.'); return }
    current.upload = up
  } else if (!up || !up.id.equals(id) || up.next !== index || up.lift !== lift || up.name !== name) {
    if (up) dropUpload(current, 'a piece arrived out of order')
    refuse(400, 'Part of the clip went missing. Send it again.')
    return
  }
  const upload = up
  upload.busy = true
  clearTimeout(upload.stall)
  try {
    const body = await readBody(req, CHUNK_BYTES + TAG_BYTES)
    if (current.upload !== upload) { reply(409, 'The link was closed.'); return }
    if (!body) { dropUpload(current, 'piece too big'); reply(413, 'That piece is too big.'); return }
    if (body.length < TAG_BYTES) { dropUpload(current, 'piece too short'); reply(400, 'Part of the clip went missing. Send it again.'); return }

    let plain: Uint8Array
    try {
      plain = chacha20poly1305(current.key, pieceNonce(id, index, last), pieceAad(lift, name)).decrypt(body)
    } catch {
      // Not encrypted with the key from this QR: a stranger, or a damaged piece.
      dropUpload(current, 'a piece did not decrypt')
      reply(400, "That didn't come from the phone that scanned this code. Scan the code again.")
      return
    }
    if (upload.bytes + plain.length > MAX_CLIP_BYTES) { dropUpload(current, 'over 2 GB'); reply(413, 'That clip is over 2 GB. Film in 1080p, or a shorter clip.'); return }
    if (last && upload.bytes + plain.length === 0) { dropUpload(current, 'empty'); reply(400, 'Nothing was sent.'); return }
    await upload.handle.write(plain)
    upload.bytes += plain.length
    upload.next = index + 1
    if (!last) {
      upload.stall = setTimeout(() => { if (current.upload === upload) dropUpload(current, 'the phone stopped sending') }, STALL_MS)
      upload.stall.unref?.()
      reply(200, '')
      return
    }
    await upload.handle.close()
    current.upload = null
    current.clip = { file: upload.file, name: upload.name, bytes: upload.bytes, lift: upload.lift }
    log(`Phone clip received: ${upload.bytes} bytes, ${upload.lift}`)
    reply(200, '', { done: true })
    // One clip per scan (D104): nothing more is accepted from this code.
    res.on('finish', () => { if (link === current) closeServer('clip received') })
  } catch (err) {
    if (current.upload === upload) dropUpload(current, err instanceof Error ? err.message : String(err))
    reply(400, err instanceof Error ? err.message : 'It did not arrive.')
  } finally {
    upload.busy = false
  }
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

/**
 * The phone page's own script. A raw string, so backslashes reach the phone as
 * written. Reads the key from after '#', encrypts each 4 MB piece and sends
 * them in order (D128).
 */
const PAGE_SCRIPT = String.raw`
  var pick = document.getElementById('pick'), send = document.getElementById('send'), fill = document.getElementById('fill'),
      pct = document.getElementById('pct'), what = document.getElementById('what'), done = document.getElementById('done'), fail = document.getElementById('fail');
  var CHUNK = __CHUNK__, AAD_PREFIX = '__AAD__', MAX_NAME = 100;
  function showFail(m) { send.hidden = true; fail.textContent = m; fail.hidden = false; }
  function b64u(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
    var bin = atob(s), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
  }
  function hex(a) { var s = ''; for (var i = 0; i < a.length; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16); return s; }
  var key = null;
  try { var m = /[#&]k=([A-Za-z0-9_-]{43})/.exec(location.hash); if (m) { key = b64u(m[1]); if (key.length !== 32) key = null; } } catch (e) { key = null; }
  if (!key || !self.cbSeal || !self.crypto || !crypto.getRandomValues) {
    pick.hidden = true;
    showFail(key ? 'This phone\'s browser is too old to send the clip safely. Try another browser.' : 'This link is missing part of its code. Scan the QR code on the computer again (typing the link: include everything after the #).');
  }
  var lift = null, goEl = document.getElementById('go'), first = document.getElementById('first');
  [].forEach.call(document.querySelectorAll('button.lift'), function (b) {
    b.onclick = function () {
      lift = b.getAttribute('data-lift');
      [].forEach.call(document.querySelectorAll('button.lift'), function (o) { o.setAttribute('aria-pressed', String(o === b)); });
      goEl.className = ''; first.hidden = true;
      document.getElementById('cam').disabled = false; document.getElementById('lib').disabled = false;
    };
  });
  function mb(n) { return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB'; }
  function readSlice(blob, cb, bad) {
    var r = new FileReader(); r.onload = function () { cb(new Uint8Array(r.result)); }; r.onerror = bad; r.readAsArrayBuffer(blob);
  }
  function go(input) {
    var f = input.files && input.files[0]; input.value = '';
    if (!f || !lift || !key) return;
    if (!f.size) { showFail('That video is empty.'); return; }
    var name = Array.from(f.name || 'phone-clip.mp4').slice(0, MAX_NAME).join('');
    var aad = new TextEncoder().encode(AAD_PREFIX + '\n' + lift + '\n' + name);
    var id = new Uint8Array(8); crypto.getRandomValues(id);
    var base = location.pathname.replace(/\/$/, '') + '/clip?u=' + hex(id) + '&lift=' + encodeURIComponent(lift) + '&name=' + encodeURIComponent(name);
    var i = 0, total = f.size;
    pick.hidden = true; fail.hidden = true; send.hidden = false; what.textContent = 'Sending ' + mb(total) + '…';
    function retry(m) { showFail(m); pick.hidden = false; }
    function next() {
      var start = i * CHUNK, end = Math.min(total, start + CHUNK), last = end >= total;
      readSlice(f.slice(start, end), function (plain) {
        var nonce = new Uint8Array(12); nonce.set(id, 0);
        var c = ((i & 0x7fffffff) | (last ? 0x80000000 : 0)) >>> 0;
        nonce[8] = c >>> 24; nonce[9] = (c >>> 16) & 255; nonce[10] = (c >>> 8) & 255; nonce[11] = c & 255;
        var body = self.cbSeal(key, nonce, aad, plain);
        var x = new XMLHttpRequest();
        x.open('POST', base + '&i=' + i + '&last=' + (last ? 1 : 0));
        x.upload.onprogress = function (e) {
          if (!e.lengthComputable) return;
          var sent = start + (end - start) * (e.loaded / e.total), p = Math.round(sent / total * 100);
          fill.style.width = p + '%'; pct.textContent = p + '% of ' + mb(total);
        };
        x.onload = function () {
          if (x.status === 200) { if (last) { send.hidden = true; done.hidden = false; } else { i++; next(); } return; }
          var m = 'It did not arrive.'; try { m = JSON.parse(x.responseText).error || m; } catch (e) {}
          if (x.status === 409 || x.status === 403) showFail(m); else retry(m);
        };
        x.onerror = function () { retry("Lost the connection to the computer. Check the phone is on the same Wi-Fi, and that CoachBoard's phone screen is still open."); };
        x.send(body);
      }, function () { retry('Could not read that video on the phone.'); });
    }
    next();
  }
  document.getElementById('cam').onchange = function () { go(this); };
  document.getElementById('lib').onchange = function () { go(this); };
`

/**
 * The phone's page: which lift it is (D127, required), then one big button that
 * opens the phone's camera, and the encrypted upload (D128).
 */
export function phonePage(): string {
  const lifts = VBT_LIFTS.map((l) => `<button type="button" class="lift" data-lift="${escapeHtml(l.id)}" aria-pressed="false">${escapeHtml(l.label)}</button>`).join('')
  const script = PAGE_SCRIPT.replace('__CHUNK__', String(CHUNK_BYTES)).replace('__AAD__', AAD_PREFIX)
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>CoachBoard — send a set</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 17px/1.45 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #0b0d0c; color: #eef1ee; }
  main { max-width: 30rem; margin: 0 auto; padding: 28px 20px 40px; }
  h1 { font-size: 22px; margin: 0 0 6px; } p { margin: 0 0 14px; color: #b9c2bb; }
  label.btn { display: block; text-align: center; padding: 18px; border-radius: 14px; font-weight: 600; font-size: 19px; background: #9fc26a; color: #0b0d0c; margin: 18px 0 10px; }
  label.alt { display: block; text-align: center; padding: 12px; border-radius: 12px; border: 1px solid #39413b; color: #eef1ee; }
  input { display: none; }
  .bar { height: 10px; background: #222824; border-radius: 6px; overflow: hidden; margin: 16px 0 8px; }
  .bar div { height: 100%; width: 0; background: #9fc26a; transition: width .2s; }
  .ok { color: #9fc26a; font-weight: 600; } .err { color: #ff8a80; }
  .hint { font-size: 14px; color: #8b948d; }
  h2 { font-size: 16px; margin: 20px 0 8px; }
  .lifts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  button.lift { font: inherit; font-size: 16px; padding: 12px 8px; border-radius: 12px; border: 1px solid #39413b; background: transparent; color: #eef1ee; }
  button.lift[aria-pressed="true"] { background: #9fc26a; border-color: #9fc26a; color: #0b0d0c; font-weight: 600; }
  #go.off label { opacity: .35; }
</style></head>
<body><main>
  <h1>Send a set to CoachBoard</h1>
  <p>Film the set with your camera, then it goes straight to the computer, encrypted.</p>
  <div id="pick">
    <h2>1. Which lift is it?</h2>
    <div class="lifts" role="group" aria-label="Which lift is it?">${lifts}</div>
    <h2>2. Film it</h2>
    <div id="go" class="off">
      <p id="first" class="hint">Pick the lift above first.</p>
      <label class="btn" for="cam">Record a set</label>
      <label class="alt" for="lib">Or pick a video you already filmed</label>
      <input id="cam" type="file" accept="video/*" capture="environment" disabled>
      <input id="lib" type="file" accept="video/*" disabled>
    </div>
    <p class="hint" style="margin-top:16px">Film from the side, with the whole plate in view and the phone held still. Film in 1080p to send in seconds — 4K takes much longer over Wi-Fi.</p>
  </div>
  <div id="send" hidden>
    <p id="what">Sending…</p>
    <div class="bar"><div id="fill"></div></div>
    <p id="pct" class="hint"></p>
  </div>
  <p id="done" class="ok" hidden>Sent. It's open on the computer.<br><span class="hint">For the next set, scan the code on the computer again.</span></p>
  <p id="fail" class="err" hidden></p>
</main>
<script>/*! @noble/ciphers ${NOBLE_CIPHERS_VERSION} (ChaCha20-Poly1305)
${PHONE_CRYPTO_LICENSE} */
${PHONE_CRYPTO_JS}</script>
<script>${script}</script>
</body></html>`
}
