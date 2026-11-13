import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { promisify } from 'util'

// ---------------------------------------------------------------------------
// A minimal .zip writer that keeps the heavy work off the main thread.
//
// The backup export used JSZip, which compresses in JavaScript on the calling
// thread. This server runs inside Electron's main process, so exporting a
// database froze the app: measured, 3.6 s of work with 205 ms freezes for a
// 105 MB database, 10.5 s with 512 ms freezes for 315 MB.
//
// Here the compression is zlib.deflateRaw, which Node runs on its libuv thread
// pool, and the CRC is computed in slices that yield between them. The output
// is plain PKZIP (deflate, UTF-8 names, no zip64), which JSZip — used by
// restore — and every OS archive tool read.
// ---------------------------------------------------------------------------

const deflateRaw = promisify(zlib.deflateRaw) as (buf: Buffer, opts: zlib.ZlibOptions) => Promise<Buffer>

/** CRC slice size: large enough to be quick, small enough not to stall. */
const CRC_SLICE = 4 * 1024 * 1024
const MAX_ZIP32 = 0xffffffff

/** An entry from memory (small files), or streamed from disk (the database). */
export type ZipEntry = { name: string; data: Buffer } | { name: string; path: string }

interface Compressed {
  crc: number
  size: number
  compressed: Buffer
}

async function crc32Yielding(data: Buffer): Promise<number> {
  let crc = 0
  for (let at = 0; at < data.length; at += CRC_SLICE) {
    crc = zlib.crc32(data.subarray(at, at + CRC_SLICE), crc)
    if (at + CRC_SLICE < data.length) await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return crc >>> 0
}

/**
 * Streams a file through the compressor. The file is never held whole: loading
 * a 315 MB database into one buffer and freeing it afterwards caused the last
 * long pause the export had (~0.4 s, in garbage collection).
 */
async function compressFile(file: string, level: number): Promise<Compressed> {
  let crc = 0
  let size = 0
  const out: Buffer[] = []
  const deflate = zlib.createDeflateRaw({ level })
  deflate.on('data', (chunk: Buffer) => out.push(chunk))
  const done = new Promise<void>((resolve, reject) => {
    deflate.on('end', resolve)
    deflate.on('error', reject)
  })
  const input = fs.createReadStream(file, { highWaterMark: 1024 * 1024 })
  for await (const chunk of input as AsyncIterable<Buffer>) {
    crc = zlib.crc32(chunk, crc)
    size += chunk.length
    if (size > MAX_ZIP32) {
      input.destroy()
      deflate.destroy()
      throw new Error(`${path.basename(file)} is larger than a standard zip entry can hold (4 GB)`)
    }
    if (!deflate.write(chunk)) await new Promise<void>((resolve) => deflate.once('drain', resolve))
  }
  deflate.end()
  await done
  return { crc: crc >>> 0, size, compressed: Buffer.concat(out) }
}

async function compressBuffer(data: Buffer, level: number): Promise<Compressed> {
  if (data.length > MAX_ZIP32) throw new Error('An entry is larger than a standard zip entry can hold (4 GB)')
  const [compressed, crc] = await Promise.all([deflateRaw(data, { level }), crc32Yielding(data)])
  return { crc, size: data.length, compressed }
}

/** MS-DOS date and time, as zip headers store them. */
function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

export async function writeZip(entries: ZipEntry[], level = 6, now = new Date()): Promise<Buffer> {
  const { time, date } = dosDateTime(now)
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const { crc, size, compressed } =
      'path' in entry ? await compressFile(entry.path, level) : await compressBuffer(entry.data, level)
    if (offset > MAX_ZIP32) throw new Error('The backup is larger than a standard zip can hold (4 GB)')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // local file header
    local.writeUInt16LE(20, 4) // version needed: 2.0 (deflate)
    local.writeUInt16LE(0x0800, 6) // flags: UTF-8 name
    local.writeUInt16LE(8, 8) // method: deflate
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28) // extra length

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0) // central directory header
    header.writeUInt16LE(20, 4) // made by
    header.writeUInt16LE(20, 6) // needed
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(8, 10)
    header.writeUInt16LE(time, 12)
    header.writeUInt16LE(date, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(compressed.length, 20)
    header.writeUInt32LE(size, 24)
    header.writeUInt16LE(name.length, 28)
    // extra, comment, disk, internal attrs, external attrs: all zero
    header.writeUInt32LE(offset, 42) // where the local header starts

    parts.push(local, name, compressed)
    central.push(header, name)
    offset += local.length + name.length + compressed.length
  }

  const centralSize = central.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // end of central directory
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, ...central, end])
}
