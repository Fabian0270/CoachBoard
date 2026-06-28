import os from 'os'

// ---------------------------------------------------------------------------
// Secure storage seam. The Express server runs inside the Electron main
// process, which owns `safeStorage` (Windows DPAPI) and the real userData path.
// Rather than importing `electron` from the server (which would break the
// plain-Node test runner), the main process injects those capabilities here at
// startup via `configureSecureStore`. Tests inject fakes the same way.
// ---------------------------------------------------------------------------

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
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

export function encryptionAvailable(): boolean {
  return !!injectedSafeStorage && injectedSafeStorage.isEncryptionAvailable()
}

/** Encrypt a secret to a base64 string, or null if secure storage is unavailable. */
export function encryptToBase64(plain: string): string | null {
  if (!encryptionAvailable()) return null
  return injectedSafeStorage!.encryptString(plain).toString('base64')
}

/** Decrypt a base64 secret, or null if unavailable / corrupt. */
export function decryptFromBase64(b64: string): string | null {
  if (!encryptionAvailable()) return null
  try {
    return injectedSafeStorage!.decryptString(Buffer.from(b64, 'base64'))
  } catch {
    return null
  }
}
