import { Router, Request, Response } from 'express'
import multer from 'multer'
import { db } from '../db.js'
import { v4 as uuidv4 } from 'uuid'

const router = Router()
const storage = multer.memoryStorage()
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } })

router.get('/', async (req: Request, res: Response): Promise<void> => {
  let query = db.selectFrom('uploaded_programs').selectAll()
  if (req.query.athlete_id) {
    query = query.where('athlete_id', '=', req.query.athlete_id as string)
  }
  const programs = await query.orderBy('uploaded_at', 'desc').execute()
  res.json(programs)
})

router.post('/', upload.single('file'), async (req: Request, res: Response): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: 'File is required' })
    return
  }
  const { athlete_id } = req.body
  const content = req.file.buffer.toString('utf-8')
  const record = await db
    .insertInto('uploaded_programs')
    .values({
      id: uuidv4(),
      athlete_id: athlete_id ?? null,
      filename: `${uuidv4()}-${req.file.originalname}`,
      original_name: req.file.originalname,
      content,
      uploaded_at: new Date().toISOString(),
    })
    .returningAll()
    .executeTakeFirstOrThrow()
  res.status(201).json(record)
})

router.get('/:id', async (req: Request, res: Response): Promise<void> => {
  const record = await db
    .selectFrom('uploaded_programs')
    .selectAll()
    .where('id', '=', req.params.id)
    .executeTakeFirst()
  if (!record) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  res.json(record)
})

router.delete('/:id', async (req: Request, res: Response): Promise<void> => {
  const deleted = await db
    .deleteFrom('uploaded_programs')
    .where('id', '=', req.params.id)
    .returningAll()
    .executeTakeFirst()
  if (!deleted) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  res.status(204).send()
})

export default router
