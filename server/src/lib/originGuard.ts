import type { NextFunction, Request, Response } from 'express'
import { log } from './logger.js'

// ---------------------------------------------------------------------------
// Only the app's own window may talk to this server.
//
// The server listens on 127.0.0.1, which keeps other MACHINES out — but not
// other WEBSITES. Any page open in the coach's ordinary browser can send
// requests to http://127.0.0.1:3001, and nothing here used to check where a
// request came from. Measured during the 2026-11 audit:
//
//   - a cross-site form POST created an athlete (201);
//   - POST /api/discord/clear-cache {days: 0} was accepted — it deletes every
//     synced video and message;
//   - a request carrying `Host: evil.example` was answered normally, which is
//     what DNS rebinding needs to read the whole API, backups included.
//
// Three checks close those, each aimed at one of them:
//
//   1. Host must be a loopback name. A rebinding attack arrives with the
//      attacker's hostname, because that is what the browser resolved.
//   2. A browser-supplied Origin must be this server's own origin, or the Vite
//      dev renderer. Browsers attach Origin to every cross-origin request and
//      to every non-GET, so this is the CSRF check.
//   3. Sec-Fetch-Site must not say cross-site or same-site. That covers what
//      Origin does not: a plain GET from an <img>, <video> or <iframe> on a
//      foreign page. "same-site" is rejected too, because every port on
//      localhost is the same SITE — another local web app would otherwise pass.
//
// Requests with none of these headers are let through. Only browsers send
// them, and a local program that can make raw HTTP requests can also read the
// database file directly, so refusing it would protect nothing.
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The Vite dev server's renderer. Its requests reach this server through the
 * dev proxy, which rewrites Host but forwards the page's Origin unchanged.
 */
const DEV_RENDERER_ORIGINS = new Set(['http://localhost:3000', 'http://127.0.0.1:3000'])

function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname
  } catch {
    return null
  }
}

/** Why a request was refused, or null to let it through. Exported for tests. */
export function rejectionReason(headers: {
  host?: string
  origin?: string
  'sec-fetch-site'?: string
}): string | null {
  const { host, origin } = headers
  const hostname = host ? hostnameOf(host) : null
  if (!hostname || !LOOPBACK_HOSTNAMES.has(hostname)) return `foreign host ${host ?? '(none)'}`

  // 'null' is what sandboxed frames and file:// pages send, and it is never us.
  if (origin !== undefined && origin !== `http://${host}` && !DEV_RENDERER_ORIGINS.has(origin)) {
    return `foreign origin ${origin}`
  }

  const site = headers['sec-fetch-site']
  if (site === 'cross-site' || site === 'same-site') return `${site} request`
  return null
}

/** Enough to diagnose a misbehaving setup, without letting a hostile page fill the log. */
const MAX_LOGGED_REJECTIONS = 20
let loggedRejections = 0

export function originGuard(req: Request, res: Response, next: NextFunction): void {
  const reason = rejectionReason({
    host: req.headers.host,
    origin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
    'sec-fetch-site':
      typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : undefined,
  })
  if (!reason) {
    next()
    return
  }
  if (loggedRejections < MAX_LOGGED_REJECTIONS) {
    loggedRejections++
    log(`Rejected ${req.method} ${req.path}: ${reason}`)
  }
  res.status(403).json({ error: 'Request rejected' })
}

/**
 * Headers that stop the app's pages being framed or content-sniffed by
 * another site. Framing is already blocked by the Sec-Fetch-Site check for a
 * browser that sends it; this covers one that does not.
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  next()
}
