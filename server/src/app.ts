import express, { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import { join } from 'path'
import { configureLogger, logError } from './lib/logger.js'
import athletesRouter from './routes/athletes.js'
import programsRouter from './routes/programs.js'
import progressRouter from './routes/progress.js'
import styleRouter from './routes/style.js'
import paymentsRouter from './routes/payments.js'
import exportStylesRouter from './routes/exportStyles.js'
import exportTemplatesRouter from './routes/exportTemplates.js'
import settingsRouter from './routes/settings.js'
import discordRouter from './routes/discord.js'
import systemRouter from './routes/system.js'
import backupRouter from './routes/backup.js'
import analysisRouter, { ANALYSIS_JSON_LIMIT } from './routes/analysis.js'
import recorderRouter from './routes/recorder.js'

export function createApp(staticDir?: string, logPath?: string) {
  const app = express()

  // Routes log through the shared logger rather than a closure, so a handler
  // anywhere in the tree can record why it failed.
  configureLogger(logPath)

  app.use(cors({ origin: ['http://localhost:3000', 'http://localhost:3001'] }))

  // Bar-path and pose payloads are megabytes, not kilobytes, so /api/analysis
  // gets its own parser MOUNTED FIRST. Order is the whole mechanism: body-parser
  // marks a request parsed, so the global parser below no-ops for anything this
  // one already read, and the generous limit stays scoped to the one router that
  // needs it instead of applying to all ~124 routes.
  //
  // This was a silent, total failure of the pose feature, not a tuning problem.
  // express.json() with no options takes a 100 kb default; a pose track is ~238 KB
  // for a couple of seconds and ~130 MB at the cap, so every PUT /:id/pose past
  // about one second of footage 413'd. The client caught it and showed "the
  // analysis was saved, but the skeleton could not be" — so the feature looked
  // merely flaky rather than broken, and no skeleton was ever stored.
  app.use('/api/analysis', express.json({ limit: ANALYSIS_JSON_LIMIT }), analysisRouter)

  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))

  app.use('/api/athletes', athletesRouter)
  app.use('/api/programs', programsRouter)
  app.use('/api/progress', progressRouter)
  app.use('/api/style-profile', styleRouter)
  app.use('/api/payments', paymentsRouter)
  app.use('/api/export-styles', exportStylesRouter)
  app.use('/api/export-templates', exportTemplatesRouter)
  app.use('/api/settings', settingsRouter)
  app.use('/api/discord', discordRouter)
  app.use('/api/system', systemRouter)
  app.use('/api/backup', backupRouter)
  // /api/analysis is mounted above, with its own body-size limit.
  app.use('/api/recorder', recorderRouter)

  // Unknown API routes must 404 as JSON, not fall through to the static catch-all
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  if (staticDir) {
    app.use(express.static(staticDir))

    // A missing VENDORED asset must 404 rather than fall through to the SPA
    // catch-all below. Same reasoning as the /api guard above, and it was found
    // the expensive way: the packaged build excludes the MediaPipe files it does
    // not load, and a request for one of the excluded ones came back
    // `200 text/html, 1073 bytes` — index.html. A loader handed that does not
    // report a missing file; it reports a corrupt one, from a URL that looks
    // like it worked. Nothing under /vendor is ever a client route.
    app.use('/vendor', (_req, res) => {
      res.status(404).json({ error: 'Not found' })
    })

    // Catch-all: serve index.html for any non-API path (HashRouter handles client routing)
    app.use((_req, res) => {
      res.sendFile(join(staticDir, 'index.html'))
    })
  }

  // Global error handler — the stack goes to the log, never to the client.
  // It used to be returned as the JSON error body, which surfaced raw internals
  // in a UI toast.
  //
  // Client errors keep their own status. Everything used to collapse to 500,
  // which meant a request that was simply too large was reported to the coach as
  // "Internal server error" — the server blaming itself for the client's input,
  // and the one status that tells you nothing about how to fix it. body-parser
  // raises 413 (too large) and 400 (malformed JSON) this way, marking them
  // `expose: true` because the message is safe to show; anything without that
  // marking is still an internal fault and still says nothing.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logError('Unhandled request error', err)
    const e = err as { status?: number; statusCode?: number; expose?: boolean; message?: string }
    const status = e?.status ?? e?.statusCode
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ error: e.expose && e.message ? e.message : 'Request rejected' })
      return
    }
    res.status(500).json({ error: 'Internal server error' })
  })

  return app
}
