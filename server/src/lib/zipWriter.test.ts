import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { randomBytes } from 'crypto'
import { writeZip } from './zipWriter.js'

// Restore reads backups with JSZip, so that is the reader this has to satisfy.

describe('writeZip', () => {
  it('writes a zip JSZip reads back byte for byte', async () => {
    const big = Buffer.concat([randomBytes(3 * 1024 * 1024), Buffer.alloc(9 * 1024 * 1024)]) // > one CRC slice
    const entries = [
      { name: 'coachboard.sqlite', data: big },
      { name: 'discord-settings.json', data: Buffer.from('{"token":"sealed"}') },
      { name: 'åäö-notes.txt', data: Buffer.from('Övning') },
      { name: 'empty.txt', data: Buffer.alloc(0) },
    ]
    const zip = await JSZip.loadAsync(await writeZip(entries))

    expect(Object.keys(zip.files).sort()).toEqual(entries.map((e) => e.name).sort())
    for (const e of entries) {
      // JSZip checks each entry's CRC as it inflates, so a wrong CRC fails here too.
      const back = await zip.file(e.name)!.async('nodebuffer')
      expect(back.equals(e.data)).toBe(true)
    }
  })

  it('streams an entry from disk to the same bytes', async () => {
    const fs = await import('fs')
    const os = await import('os')
    const path = await import('path')
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-zip-')), 'db.sqlite')
    const data = Buffer.concat([randomBytes(2 * 1024 * 1024), Buffer.alloc(5 * 1024 * 1024 + 17)]) // many read chunks, odd tail
    fs.writeFileSync(file, data)
    try {
      const zip = await JSZip.loadAsync(await writeZip([{ name: 'coachboard.sqlite', path: file }, { name: 'm.json', data: Buffer.from('{}') }]))
      expect((await zip.file('coachboard.sqlite')!.async('nodebuffer')).equals(data)).toBe(true)
      expect(await zip.file('m.json')!.async('string')).toBe('{}')
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true })
    }
  })

  it('actually compresses', async () => {
    const padded = Buffer.alloc(5 * 1024 * 1024, 0)
    expect((await writeZip([{ name: 'a', data: padded }])).length).toBeLessThan(100 * 1024)
  })
})
