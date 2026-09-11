// ---------------------------------------------------------------------------
// Reading from the embedded server.
//
// Exists because `fetch(...).then(r => r.json()).catch(() => [])` was the house
// pattern, and it turns every failure into an empty list. On a local-first app
// that is not a cosmetic problem: the screens then render their EMPTY STATE, so
// a coach with forty athletes is told "No athletes yet — add your first athlete
// to get started", and a coach with overdue invoices is told "All payments are
// up to date". The app's whole promise is that the data is safe on this machine,
// and the failure mode was a convincing claim that it is gone.
//
// Two rules, both of which the old pattern broke:
//   - a non-2xx is a failure, not data. `r.json()` on a 500 yields an error
//     OBJECT, which passed straight into state and failed an Array.isArray check
//     somewhere further down, arriving as a zero.
//   - callers must be able to tell "nothing here" from "could not ask".
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    message: string,
    /** 0 when the request never reached the server. */
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Whether the server said anything at all — false means it could not be reached. */
export const isOffline = (err: unknown): boolean => err instanceof ApiError && err.status === 0

/**
 * GET JSON, throwing on anything that is not a successful response.
 *
 * The message is written for a coach, not a developer: it appears in the retry
 * panel on the page, so "Something went wrong (500)" is more use than a stack.
 */
export async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, init)
  } catch {
    // The server runs inside the app, so this generally means it has not
    // finished starting or has stopped — not that the coach is offline.
    throw new ApiError('CoachBoard could not reach its own server.', 0)
  }
  if (!res.ok) {
    throw new ApiError(`The server could not answer that request (${res.status}).`, res.status)
  }
  try {
    return (await res.json()) as T
  } catch {
    throw new ApiError('The server sent something CoachBoard could not read.', res.status)
  }
}

/**
 * Same, but insists the answer is an array.
 *
 * Every list screen assumed it without checking, then quietly fell back to a
 * zero-length list when the assumption broke — which is precisely how a failure
 * became an empty state.
 */
export async function getList<T>(path: string, init?: RequestInit): Promise<T[]> {
  const data = await getJson<unknown>(path, init)
  if (!Array.isArray(data)) {
    throw new ApiError('The server sent something CoachBoard could not read.', 200)
  }
  return data as T[]
}

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : 'Something went wrong.'
