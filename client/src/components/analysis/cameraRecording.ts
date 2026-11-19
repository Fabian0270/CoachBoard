import { BlobSource, BufferTarget, Conversion, Input, Output, WEBM, WebMOutputFormat } from 'mediabunny'

// ---------------------------------------------------------------------------
// Recording a set from a camera (BP41).
//
// MediaRecorder writes a WebM as it goes, so it never goes back to fill in the
// length or the seek index: the file plays, but its duration reads as unknown.
// Measured in the packaged app (2026-11-19): tracking coped, but a saved
// analysis is scrubbed and seeked later, so every recording is rewritten into
// an ordinary WebM first — the video copied, not re-encoded, which took 17 ms
// for an 8-second 720p clip.
// ---------------------------------------------------------------------------

/** The best WebM the browser can record. VP9 keeps plate detail at a modest size. */
export function cameraMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t))
}

/**
 * Enough for a sharp plate edge at 1080p; the tracker reads 320 px frames, so
 * more would only make the file bigger. About 60 MB a minute.
 */
export const CAMERA_BITS_PER_SECOND = 8_000_000

/** Stopped on its own after this long: a set is never that long, and the file keeps growing. */
export const MAX_RECORDING_MS = 3 * 60 * 1000

/** "camera-2026-11-19-1432.webm", in the coach's local time. */
export function recordingFileName(at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `camera-${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}.webm`
}

/** The recording, rewritten with a length and seek index. Falls back to the raw file if that fails. */
export async function finishRecording(raw: Blob, name: string): Promise<File> {
  try {
    const input = new Input({ source: new BlobSource(raw), formats: [WEBM] })
    const target = new BufferTarget()
    const output = new Output({ format: new WebMOutputFormat(), target })
    const conversion = await Conversion.init({ input, output })
    if (!conversion.isValid) throw new Error('The recording could not be read back.')
    await conversion.execute()
    if (!target.buffer) throw new Error('Nothing was written.')
    return new File([target.buffer], name, { type: 'video/webm' })
  } catch (err) {
    // The raw file still tracks (measured); only seeking it later is worse.
    console.warn('Camera recording kept as recorded:', err)
    return new File([raw], name, { type: 'video/webm' })
  }
}

/** "1:05" */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
