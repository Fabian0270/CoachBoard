// ---------------------------------------------------------------------------
// Which exercise names to offer for what the coach has typed.
//
// Two sources: the names the coach has used in their own programs (most used
// first), and the built-in directory. The coach's own always come first — it is
// their spelling and their variations ("Comp Bench", "SSB Squat") they are
// reaching for, and the built-in list does not know those exist.
// ---------------------------------------------------------------------------

/** Names in `names` matching `q` (lower-cased): those that start with it, then those that contain it. */
function ranked(names: readonly string[], q: string, skip: Set<string>): string[] {
  const starts: string[] = []
  const contains: string[] = []
  for (const name of names) {
    const lower = name.trim().toLowerCase()
    if (lower === '' || lower === q || skip.has(lower)) continue
    if (lower.startsWith(q)) starts.push(name)
    else if (lower.includes(q)) contains.push(name)
    else continue
    skip.add(lower)
  }
  return [...starts, ...contains]
}

/**
 * Suggestions for `typed`, best first.
 *
 * A name equal to what is typed is left out (there is nothing to suggest), and
 * a built-in name the coach already uses appears once, in their spelling.
 */
export function matchSuggestions(
  own: readonly string[],
  builtIn: readonly string[],
  typed: string,
  limit = 8,
): string[] {
  const q = typed.trim().toLowerCase()
  if (!q) return []
  const seen = new Set<string>()
  return [...ranked(own, q, seen), ...ranked(builtIn, q, seen)].slice(0, limit)
}
