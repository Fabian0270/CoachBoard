import { getDb } from '../db.js'

export const db = new Proxy({} as ReturnType<typeof getDb>, {
  get: (_t, p) => {
    const target = getDb()
    const val = Reflect.get(target, p)
    return typeof val === 'function' ? (val as Function).bind(target) : val
  },
})

export const toIsoDate = (d: Date) => d.toISOString().slice(0, 10)
