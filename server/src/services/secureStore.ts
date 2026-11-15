import os from 'os'

// ---------------------------------------------------------------------------
// Secure storage seam. The Express server runs inside the Electron main
// process, which owns `safeStorage` (Windows DPAPI) and the real userData path.
// Rather than importing `electron` from the server (which would break the
// plain-Node test runner), the main process injects those capabilities here at
// startup via `configureSecureStore`. Tests inject fakes the same way.
// ---------------------------------------------------------------------------

/**
 * The asynchronous safeStorage API. The synchronous one (isEncryptionAvailable,
 * encryptString, decryptString) is deprecated in Electron 45 and removed in 46.
 * Both use the same OS key store, so secrets saved by earlier versions with
 * encryptString still decrypt here.
 */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(plainText: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string }>
}

let injectedSafeStorage: SafeStorageLike | null = null
let injectedUserDataDir: string | null = null

/** Wired once at startup by the Electron main process (and by tests with fakes). */
export function configureSecureStore(opts: {
  safeStorage?: SafeStorageLike | null
  userDataDir?: string | null
}): void {
  if ('safeStorage' in opts) injectedSafeStorage = opts.safeStorage ?? null
  if ('userDataDir' in opts) injectedUserDataDir = opts.userDataDir ?? null
}

/** Directory for app-managed config files. Falls back to a temp dir off-Electron. */
export function userDataDir(): string {
  return injectedUserDataDir || process.env.COACHBOARD_USERDATA_DIR || os.tmpdir()
}

export async function encryptionAvailable(): Promise<boolean> {
  if (!injectedSafeStorage) return false
  try {
    return await injectedSafeStorage.isAsyncEncryptionAvailable()
  } catch {
    return false
  }
}

/** Encrypt a secret to a base64 string, or null if secure storage is unavailable. */
export async function encryptToBase64(plain: string): Promise<string | null> {
  if (!(await encryptionAvailable())) return null
  return (await injectedSafeStorage!.encryptStringAsync(plain)).toString('base64')
}

/** Decrypt a base64 secret, or null if unavailable / corrupt. */
export async function decryptFromBase64(b64: string): Promise<string | null> {
  if (!(await encryptionAvailable())) return null
  try {
    return (await injectedSafeStorage!.decryptStringAsync(Buffer.from(b64, 'base64'))).result
  } catch {
    return null
  }
}
