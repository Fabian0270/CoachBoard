import { existsSync } from 'fs'
import BetterSqlite3 from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Every better-sqlite3 handle in the server is opened through here.
//
// WHY THIS EXISTS: better-sqlite3 is a native addon, so the compiled .node file
// only loads under the ABI it was built for. The app runs it under Electron
// (postinstall runs electron-rebuild), but the test suite runs under plain Node,
// and the two ABIs are incompatible.
//
// The test runner used to resolve that by swapping the binary inside
// node_modules for the duration of the run and restoring it afterwards. That
// made an interrupted run (Ctrl+C, a killed terminal, a crash) leave the repo
// holding a Node-ABI binary, and the symptom showed up much later and somewhere
// else entirely: the app dying at launch with a raw NODE_MODULE_VERSION error.
//
// So the shared file is no longer touched at all. better-sqlite3 accepts an
// explicit `nativeBinding` path, and the test runner points this at a cached
// Node-ABI copy via COACHBOARD_SQLITE_BINDING. node_modules keeps its Electron
// build permanently, and there is no window in which an interruption can leave
// the checkout broken.
// ---------------------------------------------------------------------------

/**
 * Path to an alternate compiled better-sqlite3 addon, or undefined to use the
 * one in node_modules. Set only by `server/scripts/run-tests.cjs`; production
 * never sets it.
 */
function overrideBindingPath(): string | undefined {
  const configured = process.env.COACHBOARD_SQLITE_BINDING
  if (!configured) return undefined
  if (!existsSync(configured)) {
    // Loud rather than mysterious: a stale path here would otherwise surface as
    // an opaque module-load failure from deep inside better-sqlite3.
    throw new Error(
      `COACHBOARD_SQLITE_BINDING points at a file that does not exist: ${configured}\n` +
        'Delete node_modules/.cache/coachboard-sqlite-abi and re-run the tests to rebuild it.',
    )
  }
  return configured
}

export type SqliteOptions = BetterSqlite3.Options

/** Opens a database using whichever compiled addon suits the current runtime. */
export function openSqlite(path: string, options: SqliteOptions = {}): BetterSqlite3.Database {
  const nativeBinding = overrideBindingPath()
  return new BetterSqlite3(path, nativeBinding ? { ...options, nativeBinding } : options)
}
