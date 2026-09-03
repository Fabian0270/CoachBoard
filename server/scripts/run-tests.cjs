/**
 * Runs the server test suite under plain Node.
 *
 * better-sqlite3 is a native addon compiled for ONE ABI. The app runs it under
 * Electron (postinstall runs electron-rebuild); the tests run under plain Node.
 *
 * This script used to bridge that by swapping the binary inside node_modules for
 * the duration of the run and restoring it in a `finally`. That worked right up
 * until a run was interrupted — Ctrl+C, a closed terminal, a killed process —
 * after which the checkout silently held a Node-ABI binary and the NEXT thing to
 * break was the app itself, dying at launch with a raw NODE_MODULE_VERSION error
 * that pointed nowhere near the tests. Re-running the tests didn't fix it
 * either: the script saw a working Node binary, concluded no swap was needed,
 * and so never restored the Electron one.
 *
 * The shared file is no longer swapped. A Node-ABI copy is built ONCE into
 * node_modules/.cache and the tests are pointed at it through
 * COACHBOARD_SQLITE_BINDING (see server/src/sqlite.ts), so node_modules keeps
 * its Electron build permanently.
 *
 * Two safety nets cover what remains. The one-time build still has to borrow the
 * shared path (npm rebuild only writes there), so that window is guarded by a
 * marker file plus exit/signal handlers. And `heal()` runs on every invocation,
 * so a checkout left broken by an older version of this script — or by a kill
 * signal no handler can catch — is fixed by the next test run rather than
 * surfacing later as a failure to launch the app.
 *
 * Usage:
 *   node scripts/run-tests.cjs [vitest args...]   run the suite (default: run)
 *   node scripts/run-tests.cjs --repair           restore the Electron binary and exit
 */
const { execSync, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..', '..')
const serverDir = path.resolve(__dirname, '..')
const binaryPath = path.join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
const cacheDir = path.join(root, 'node_modules', '.cache', 'coachboard-sqlite-abi')
const electronCache = path.join(cacheDir, 'better_sqlite3.electron.node')
const nodeCache = path.join(cacheDir, `better_sqlite3.node-abi${process.versions.modules}.node`)
/** Written only while the shared binary is borrowed; its presence means a restore is owed. */
const markerPath = path.join(cacheDir, 'BORROWED')

/**
 * Whether the addon at `file` can be loaded by plain Node — i.e. whether it is
 * the Node-ABI build rather than the Electron one.
 *
 * Probed in a CHILD process on purpose. Loading a .node addon into this process
 * makes Windows hold an open handle on the file, and every caller here is about
 * to overwrite exactly that path — an in-process probe turns the subsequent copy
 * into an EPERM and leaves the repair worse than the problem.
 */
function loadsUnderNode(file) {
  if (!fs.existsSync(file)) return false
  const probe = `new (require('better-sqlite3'))(':memory:', { nativeBinding: ${JSON.stringify(file)} }).close()`
  return spawnSync(process.execPath, ['-e', probe], { cwd: root, stdio: 'ignore' }).status === 0
}

/**
 * Puts the Electron binary back into node_modules if it isn't there.
 *
 * Covers both ways the checkout can end up wrong: an interrupted borrow (marker
 * present) and a checkout already broken by the previous swap-based script (no
 * marker, but node_modules holding an addon that loads under Node — which the
 * Electron build never does).
 */
function heal(quiet) {
  const owed = fs.existsSync(markerPath)
  const mismatched = fs.existsSync(electronCache) && loadsUnderNode(binaryPath)
  if (!owed && !mismatched) return false

  if (fs.existsSync(electronCache)) {
    fs.copyFileSync(electronCache, binaryPath)
    if (!quiet) console.log('[run-tests] Restored the Electron better-sqlite3 binary into node_modules.')
  } else if (!quiet) {
    console.warn('[run-tests] node_modules needs the Electron better-sqlite3 binary but none is cached.')
    console.warn('[run-tests] Run: npx electron-rebuild -f -w better-sqlite3')
  }
  fs.rmSync(markerPath, { force: true })
  return true
}

/**
 * Ensures a Node-ABI addon exists in the cache, building it once if needed.
 *
 * `npm rebuild` can only write to the real node_modules path, so the Electron
 * binary is parked and a marker dropped for the duration of that build. Every
 * exit path — normal, thrown, or signalled — puts it back.
 */
function ensureNodeAbiBinary() {
  if (fs.existsSync(nodeCache)) return
  fs.mkdirSync(cacheDir, { recursive: true })

  // CI installs with --ignore-scripts and rebuilds for Node, so node_modules
  // already holds exactly what the tests need. Cache it rather than rebuilding,
  // and — importantly — never park a Node addon under the Electron name.
  if (loadsUnderNode(binaryPath)) {
    fs.copyFileSync(binaryPath, nodeCache)
    return
  }

  console.log('[run-tests] Building better-sqlite3 for Node (one-time)...')
  fs.copyFileSync(binaryPath, electronCache)
  fs.writeFileSync(markerPath, new Date().toISOString())

  // Restoring is idempotent, so wiring it to several exits at once is safe.
  const restore = () => heal(true)
  const onSignal = (sig) => {
    restore()
    process.exit(sig === 'SIGINT' ? 130 : 143)
  }
  process.on('exit', restore)
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  process.on('SIGHUP', onSignal)

  try {
    execSync('npm rebuild better-sqlite3', { cwd: root, stdio: 'inherit' })
    fs.copyFileSync(binaryPath, nodeCache)
  } finally {
    heal(true)
    process.off('exit', restore)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    process.off('SIGHUP', onSignal)
  }
}

function runVitest() {
  const args = process.argv.length > 2 ? process.argv.slice(2) : ['run']
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), ...args],
    {
      cwd: serverDir,
      stdio: 'inherit',
      // The whole point: tests load the cached Node addon, and node_modules is
      // left holding the Electron build without ever being written to.
      env: { ...process.env, COACHBOARD_SQLITE_BINDING: nodeCache },
    },
  )
  return result.status ?? 1
}

if (process.argv.includes('--repair')) {
  if (!heal(false)) console.log('[run-tests] Nothing to repair — node_modules already holds the Electron binary.')
  process.exit(0)
}

// Always heal first: an interrupted earlier run must not leak into this one.
heal(false)
ensureNodeAbiBinary()
process.exit(runVitest())
