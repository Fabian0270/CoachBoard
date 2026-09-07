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
import analysisRouter from './routes/analysis.js'
import recorderRouter from './routes/recorder.js'

export function createApp(staticDir?: string, logPath?: string) {
  const app = express()

  // Routes log through the shared logger rather than a closure, so a handler
  // anywhere in the tree can record why it failed.
  configureLogger(logPath)

  app.use(cors({ origin: ['http://localhost:3000', 'http://localhost:3001'] }))
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
  app.use('/api/analysis', analysisRouter)
  app.use('/api/recorder', recorderRouter)

  // Unknown API routes must 404 as JSON, not fall through to the static catch-all
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  if (staticDir) {
    app.use(express.static(staticDir))
    // Catch-all: serve index.html for any non-API path (HashRouter handles client routing)
    app.use((_req, res) => {
      res.sendFile(join(staticDir, 'index.html'))
    })
  }

  // Global error handler — the stack goes to the log, never to the client.
  // It used to be returned as the JSON error body, which surfaced raw internals
  // in a UI toast.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logError('Unhandled request error', err)
    res.status(500).json({ error: 'Internal server error' })
  })

  return app
}
