import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import QRCode from 'qrcode'
import { VBT_LIFTS, isVbtLift, type VbtLift } from 'coachboard-shared/vbt'
import { userDataDir } from './secureStore.js'
import { extensionFor } from './analysisVideoStore.js'
import { log } from '../lib/logger.js'

// ---------------------------------------------------------------------------
// The phone link (BP41 part b, D100, D104–D106).
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
// one-time code in the QR: the phone page, and one video upload. After that
// one clip it closes (one clip per scan, D104). Nothing else of CoachBoard is
// reachable from the network.
// ---------------------------------------------------------------------------

/** D106: anything a phone films is accepted, up to this. */
export const MAX_CLIP_BYTES = 2 * 1024 ** 3

/** The link closes itself if nothing arrives for this long. */
const IDLE_MS = 30 * 60 * 1000

export interface PhoneLinkStatus {
  active: boolean
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

interface Link {
  token: string
  server: http.Server
  port: number
  urls: string[]
  qrSvg: string
  receiving: number | null
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
    url: link?.urls[0] ?? null,
    otherUrls: link?.urls.slice(1) ?? [],
    qrSvg: link?.qrSvg ?? null,
    receiving: link?.receiving ?? null,
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

function closeServer(why: string | null): void {
  if (!link) return
  clearTimeout(link.idle)
  if (!link.open) return
  link.open = false
  link.server.close()
  // Keep-alive sockets would otherwise hold the port open until they time out.
  link.server.closeAllConnections?.()
  log(`Phone link closed${why ? `: ${why}` : ''}`)
}

/** Stop the link. A clip that arrived but was never opened is deleted. */
export function stopPhoneLink(): PhoneLinkStatus {
  if (link) {
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

/** Start the link, or return the one already running (the same QR keeps working). */
export async function startPhoneLink(opts: { addresses?: string[] } = {}): Promise<PhoneLinkStatus> {
  if (link && !link.clip) return phoneLinkStatus()
  stopPhoneLink()
  sweepClips()
  const addresses = opts.addresses ?? lanAddresses(os.networkInterfaces())
  if (addresses.length === 0) {
    throw new PhoneLinkError("This computer isn't on a network a phone can reach. Connect it to the gym's Wi-Fi (or the same network as your phone), then try again.")
  }
  const token = crypto.randomBytes(16).toString('hex')
  const server = http.createServer((req, res) => handle(req, res))
  // Every address, not one: the phone may reach this computer through any of
  // them. The code in the path is what keeps everything else out.
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '0.0.0.0', () => resolve((server.address() as { port: number }).port))
  })
  const urls = addresses.map((a) => `http://${a}:${port}/p/${token}`)
  const qrSvg = await QRCode.toString(urls[0], { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
  link = { token, server, port, urls, qrSvg, receiving: null, clip: null, idle: setTimeout(() => expire(), IDLE_MS), open: true }
  link.idle.unref?.()
  closedBecause = null
  log(`Phone link open on port ${port} (${addresses.join(', ')})`)
  return phoneLinkStatus()
}

function expire(): void {
  if (!link || link.clip) return
  closeServer('nothing arrived for 30 minutes')
  link = null
  closedBecause = 'The phone link closed after 30 minutes with nothing sent. Start it again to send a clip.'
}

export class PhoneLinkError extends Error {}

/** Only the two routes; anything else, or the wrong code, is a plain 404. */
function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const current = link
  const url = new URL(req.url ?? '/', 'http://phone')
  const parts = url.pathname.split('/').filter(Boolean) // ['p', token] or ['p', token, 'clip']
  const tokenOk = !!current && parts[0] === 'p' && parts[1] === current.token
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  if (!tokenOk || !current) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
    return
  }
  if (req.method === 'GET' && parts.length === 2) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:",
    })
    res.end(phonePage())
    return
  }
  if (req.method === 'POST' && parts.length === 3 && parts[2] === 'clip') {
    void receive(current, url, req, res)
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
}

async function receive(current: Link, url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const reply = (status: number, message: string) => {
    if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(status === 200 ? { ok: true } : { error: message }))
  }
  if (current.clip || current.receiving !== null) { reply(409, 'A clip is already on its way. Scan the code again for the next set.'); return }
  const declared = Number(req.headers['content-length'] ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_CLIP_BYTES) { reply(413, 'That clip is over 2 GB. Film in 1080p, or a shorter clip.'); req.resume(); return }
  // D127: the lift is picked on the phone before filming, and the analysis goes by it.
  const lift = url.searchParams.get('lift')
  if (!isVbtLift(lift)) { reply(400, 'Pick the lift first.'); req.resume(); return }
  const name = (url.searchParams.get('name') ?? 'phone-clip.mp4').slice(0, 120)
  fs.mkdirSync(clipDir(), { recursive: true })
  const file = path.join(clipDir(), `${crypto.randomUUID()}${extensionFor(name)}`)
  const out = fs.createWriteStream(file)
  current.receiving = 0
  clearTimeout(current.idle)
  let bytes = 0
  let failed: string | null = null
  req.on('data', (chunk: Buffer) => {
    bytes += chunk.length
    current.receiving = bytes
    if (bytes > MAX_CLIP_BYTES && !failed) { failed = 'That clip is over 2 GB. Film in 1080p, or a shorter clip.'; req.destroy() }
  })
  req.pipe(out)
  try {
    await new Promise<void>((resolve, reject) => {
      out.on('finish', resolve)
      out.on('error', reject)
      req.on('error', reject)
      req.on('aborted', () => reject(new Error('The phone stopped sending.')))
    })
  } catch (err) {
    failed ??= err instanceof Error ? err.message : String(err)
  }
  if (failed || bytes === 0 || link !== current) {
    out.destroy()
    fs.rmSync(file, { force: true })
    current.receiving = null
    if (link === current) current.idle = setTimeout(() => expire(), IDLE_MS)
    reply(failed?.includes('2 GB') ? 413 : 400, failed ?? (bytes === 0 ? 'Nothing was sent.' : 'The link was closed.'))
    log(`Phone clip not received: ${failed ?? 'empty or closed'}`)
    return
  }
  current.receiving = null
  current.clip = { file, name, bytes, lift }
  log(`Phone clip received: ${name}, ${bytes} bytes, ${lift}`)
  reply(200, '')
  // One clip per scan (D104): nothing more is accepted from this code.
  res.on('finish', () => { if (link === current) closeServer('clip received') })
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

/**
 * The phone's page: which lift it is (D127, required), then one big button that
 * opens the phone's camera, and the upload.
 */
function phonePage(): string {
  const lifts = VBT_LIFTS.map((l) => `<button type="button" class="lift" data-lift="${escapeHtml(l.id)}" aria-pressed="false">${escapeHtml(l.label)}</button>`).join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
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
  <p>Film the set with your camera, then it goes straight to the computer.</p>
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
<script>
  var pick = document.getElementById('pick'), send = document.getElementById('send'), fill = document.getElementById('fill'),
      pct = document.getElementById('pct'), what = document.getElementById('what'), done = document.getElementById('done'), fail = document.getElementById('fail');
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
  function go(input) {
    var f = input.files && input.files[0]; if (!f || !lift) return;
    pick.hidden = true; fail.hidden = true; send.hidden = false; what.textContent = 'Sending ' + mb(f.size) + '…';
    var x = new XMLHttpRequest();
    x.open('POST', location.pathname.replace(/\\/$/, '') + '/clip?lift=' + encodeURIComponent(lift) + '&name=' + encodeURIComponent(f.name || 'phone-clip.mp4'));
    x.upload.onprogress = function (e) { if (e.lengthComputable) { var p = Math.round(e.loaded / e.total * 100); fill.style.width = p + '%'; pct.textContent = p + '% of ' + mb(e.total); } };
    x.onload = function () {
      send.hidden = true;
      if (x.status === 200) { done.hidden = false; return; }
      var m = 'It did not arrive.'; try { m = JSON.parse(x.responseText).error || m; } catch (e) {}
      fail.textContent = m; fail.hidden = false; if (x.status !== 409) pick.hidden = false;
    };
    x.onerror = function () { send.hidden = true; fail.textContent = "Lost the connection to the computer. Check the phone is on the same Wi-Fi, and that CoachBoard's phone screen is still open."; fail.hidden = false; pick.hidden = false; };
    x.send(f);
    input.value = '';
  }
  document.getElementById('cam').onchange = function () { go(this); };
  document.getElementById('lib').onchange = function () { go(this); };
</script>
</body></html>`
}
