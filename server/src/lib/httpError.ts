import type { Response } from 'express'
import { logError } from './logger.js'

/**
 * Fail a request: log the real error, send the coach a generic message.
 *
 * Route handlers used to `catch {}` without binding the error at all, so a
 * constraint violation, a Kysely bug and a null dereference all reached the coach
 * as the same string with the stack destroyed — nothing was left to debug from.
 *
 * The client-facing `message` stays exactly as generic as it was. The split is
 * deliberate: detail goes to the log file, never over the wire.
 */
export function fail(res: Response, message: string, err: unknown, status = 500): void {
  logError(message, err)
  res.status(status).json({ error: message })
}
