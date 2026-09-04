/**
 * Parses a number out of a text input, accepting Swedish comma decimals.
 *
 * Every numeric field in the app is typed by a Swedish coach on a Swedish
 * keyboard layout, where the decimal key produces a comma. Without this, "2,5"
 * parses to NaN and the field silently does nothing.
 *
 * Returns NaN on anything unparseable, exactly as `Number` does — callers guard
 * with `Number.isFinite`.
 */
export function num(value: string): number {
  return Number(value.replace(',', '.'))
}
