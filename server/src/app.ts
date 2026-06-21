import express, { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import { join } from 'path'
import fs from 'fs'
import athletesRouter from './routes/athletes.js'
import programsRouter from './routes/programs.js'
import progressRouter from './routes/progress.js'
import styleRouter from './routes/style.js'
import paymentsRouter from './routes/payments.js'

export function createApp(staticDir?: string, logPath?: string) {
  const app = express()

  const log = (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`
    if (logPath) try { fs.appendFileSync(logPath, line) } catch { /* ignore */ }
    console.log(msg)
  }

  app.use(cors({ origin: ['http://localhost:3000', 'http://localhost:3001'] }))
  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))

  app.use('/api/athletes', athletesRouter)
  app.use('/api/programs', programsRouter)
  app.use('/api/progress', progressRouter)
  app.use('/api/style-profile', styleRouter)
  app.use('/api/payments', paymentsRouter)

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

  // Global error handler — logs the error and returns JSON
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err)
    log(`EXPRESS ERROR: ${msg}`)
    res.status(500).json({ error: msg })
  })

  return app
}
