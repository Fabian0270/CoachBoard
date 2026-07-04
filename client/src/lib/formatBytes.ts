const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** Human-readable byte size, e.g. humanBytes(3623878656) → "3.4 GB". */
export function humanBytes(bytes: number): string {
  if (!bytes || bytes < 1) return '0 B'
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
  const value = bytes / 1024 ** exp
  // Whole numbers for bytes/KB; one decimal for MB and up.
  const rounded = exp <= 1 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${UNITS[exp]}`
}
