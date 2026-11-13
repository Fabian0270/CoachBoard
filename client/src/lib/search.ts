// ---------------------------------------------------------------------------
// Client-side search for the Athletes and Programs lists.
//
// Both pages already hold the whole list, so filtering here is instant and
// needs no server change. Every word typed must appear in one of the fields,
// in any order: "lind squat" finds Maja Lind's squat block. Case and accents
// are ignored, so "asa" finds Åsa and "malmo" finds Malmö.
// ---------------------------------------------------------------------------

/** Lowercase with accents removed: "Åsa Öberg" → "asa oberg". */
export function foldForSearch(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** True when every word of `query` appears in at least one of `fields`. A blank query matches everything. */
export function matchesSearch(query: string, fields: Array<string | null | undefined>): boolean {
  const words = foldForSearch(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const haystack = fields.filter((f): f is string => !!f).map(foldForSearch).join('\n')
  return words.every((w) => haystack.includes(w))
}
