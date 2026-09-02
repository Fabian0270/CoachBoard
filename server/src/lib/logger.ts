import fs from 'fs'

/**
 * Process-wide logger for the embedded server.
 *
 * In a packaged install this log file is the ONLY diagnostic channel that exists:
 * there is no console for a coach to read and no crash reporting. Route handlers
 * write here so a 500 in the field can still be explained after the fact.
 *
 * The Electron main process owns the path (userData/coachboard.log) and passes it
 * to `createApp`, which calls `configureLogger`. Until then, or in tests, logging
 * falls back to stdout only.
 */

/** Roll the log once it passes this size, so it can't grow for the life of the install. */
const MAX_BYTES = 5 * 1024 * 1024

let logPath: string | undefined

/** Point the logger at a file. Called once by `createApp`. */
export function configureLogger(path?: string): void {
  logPath = path
}

/**
 * Roll the log when it gets large, keeping a single previous generation as `.1`.
 * Best-effort by design — a rotation failure must never stop the actual logging.
 */
function rotateIfNeeded(path: string): void {
  try {
    if (fs.statSync(path).size < MAX_BYTES) return
    fs.rmSync(`${path}.1`, { force: true })
    fs.renameSync(path, `${path}.1`)
  } catch {
    /* file missing, locked, or unwritable — fall through and just append */
  }
}

export function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  if (logPath) {
    rotateIfNeeded(logPath)
    try {
      fs.appendFileSync(logPath, line)
    } catch {
      /* disk full or permissions — logging must never throw into a request */
    }
  }
  console.log(msg)
}

/**
 * Log an error with its stack intact.
 *
 * The stack is written here and deliberately never returned to the client — see
 * `fail` in ./httpError.ts for the wire side of that split.
 */
export function logError(context: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  log(`ERROR ${context}: ${detail}`)
}
