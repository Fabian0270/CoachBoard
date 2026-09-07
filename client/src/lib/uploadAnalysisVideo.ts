// ---------------------------------------------------------------------------
// Uploads a locally imported clip so a saved analysis can be replayed later.
//
// Chunked rather than one request: a lift clip runs to hundreds of megabytes,
// and a single body would be buffered whole in the server process that is also
// serving the app. Same shape as the recorder's chunk upload, and the same
// reason — see server/src/services/analysisVideoStore.ts.
//
// Nothing is uploaded until the coach actually saves. Analysing a clip still
// costs nothing, because the analyser runs entirely in the renderer.
// ---------------------------------------------------------------------------

export interface StoredVideo {
  relPath: string
  bytes: number
}

/** Comfortably under the route's 32 MB cap, and small enough to retry cheaply. */
const CHUNK_BYTES = 8 * 1024 * 1024

async function post(url: string, body?: BodyInit): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    ...(body ? { headers: { 'Content-Type': 'application/octet-stream' }, body } : {}),
  })
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(payload.error ?? 'Upload failed')
  }
  return res
}

export async function uploadVideo(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<StoredVideo> {
  const begun = (await (
    await post(`/api/analysis/video?filename=${encodeURIComponent(file.name)}`)
  ).json()) as { id: string; ext: string }

  const query = `ext=${encodeURIComponent(begun.ext)}`
  // Sequential on purpose: the chunks are appended to one file, so two in
  // flight at once would interleave and corrupt it.
  for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
    const chunk = file.slice(offset, Math.min(offset + CHUNK_BYTES, file.size))
    await post(`/api/analysis/video/${begun.id}/chunk?${query}`, chunk)
    onProgress?.(Math.min(1, (offset + CHUNK_BYTES) / file.size))
  }

  return (await (
    await post(`/api/analysis/video/${begun.id}/finish?${query}`)
  ).json()) as StoredVideo
}
