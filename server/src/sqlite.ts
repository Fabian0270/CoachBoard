import BetterSqlite3 from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Every better-sqlite3 handle in the server is opened through here.
//
// better-sqlite3 is a native addon. Up to 1.16 it was compiled per ABI, so the
// app (Electron) and the test suite (plain Node) each needed their own build,
// and an elaborate test runner swapped and cached binaries between them — an
// interrupted run once left the app dying at launch with NODE_MODULE_VERSION.
//
// From better-sqlite3 13 (adopted with the Electron 45 upgrade in 1.17.0) the
// addon is built against Node-API, which is ABI-stable: one prebuilt binary per
// platform, shipped inside the package, loads under Electron and Node alike. No
// rebuild, no override, nothing to swap. Kept as the single entry point so a
// future change of driver or options has one place to land.
// ---------------------------------------------------------------------------

export type SqliteOptions = BetterSqlite3.Options

export function openSqlite(path: string, options: SqliteOptions = {}): BetterSqlite3.Database {
  return new BetterSqlite3(path, options)
}
