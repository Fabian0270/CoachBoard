import { beforeAll, describe, it, expect } from 'vitest'
import { initializeDatabase } from '../db.js'
import { createAthlete, findAllAthletes, findAthleteById } from './athleteService.js'

beforeAll(async () => {
  await initializeDatabase(':memory:')
})

describe('archived athletes (Feature 4d)', () => {
  it('createAthlete defaults to not archived', async () => {
    const a = await createAthlete({ name: 'Active Alice' })
    expect(a.archived).toBe(0)
  })

  it('createAthlete can create a minimal archived owner', async () => {
    const a = await createAthlete({ name: 'Archived Andy', archived: true })
    expect(a.archived).toBe(1)
    // Stored and retrievable by id even though it's hidden from the roster.
    const fetched = await findAthleteById(a.id)
    expect(fetched?.archived).toBe(1)
  })

  it('findAllAthletes hides archived athletes by default', async () => {
    const list = await findAllAthletes()
    expect(list.some((a) => a.name === 'Active Alice')).toBe(true)
    expect(list.some((a) => a.name === 'Archived Andy')).toBe(false)
    expect(list.every((a) => a.archived === 0)).toBe(true)
  })

  it('findAllAthletes includes archived when asked', async () => {
    const list = await findAllAthletes({ includeArchived: true })
    expect(list.some((a) => a.name === 'Active Alice')).toBe(true)
    expect(list.some((a) => a.name === 'Archived Andy')).toBe(true)
  })
})
