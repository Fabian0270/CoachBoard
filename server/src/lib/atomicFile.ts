import fs from 'fs/promises'

// ---------------------------------------------------------------------------
// Settings files that survive a crash and two writers.
//
// The email and Discord settings are JSON files rewritten in place, and both
// failure modes were silent:
//
//   - A crash or power cut mid-write left a truncated file. The readers treat
//     unparseable JSON as "not configured", so the coach's SMTP setup or Discord
//     connection simply vanished — the bot token with it.
//   - Every setter is read-modify-write. Two of them at once (the auto-sync
//     toggle and the retention dropdown, say) both read the old file and the
//     second write discarded the first.
//
// Writes now go to a temporary file renamed over the real one, which is atomic
// on the same volume, and each file's updates run one at a time.
// ---------------------------------------------------------------------------

/** Windows can briefly refuse a rename while antivirus or the indexer holds the target. */
const RENAME_ATTEMPTS = 5

export async function writeFileAtomic(file: string, contents: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, contents, 'utf8')
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(tmp, file)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt >= RENAME_ATTEMPTS || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        await fs.rm(tmp, { force: true }).catch(() => {})
        throw err
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
    }
  }
}

/**
 * Runs read-modify-write updates for one file strictly one after another.
 * A failed update does not block the ones queued behind it.
 */
export function createUpdateQueue(): <T>(update: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(update: () => Promise<T>): Promise<T> => {
    const run = tail.then(update, update)
    tail = run.catch(() => {})
    return run
  }
}
