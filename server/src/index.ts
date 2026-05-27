import express from 'express'
import cors from 'cors'
import { initializeDatabase } from './db.js'
import athletesRouter from './routes/athletes.js'
import programsRouter from './routes/programs.js'
import progressRouter from './routes/progress.js'

const app = express()
const PORT = 3001

app.use(cors({ origin: 'http://localhost:3000' }))
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.use('/api/athletes', athletesRouter)
app.use('/api/programs', programsRouter)
app.use('/api/progress', progressRouter)

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`)
    })
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err)
    process.exit(1)
  })
