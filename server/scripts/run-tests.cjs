/**
 * Runs the server test suite under plain Node.
 *
 * better-sqlite3 is normally compiled for Electron's ABI (postinstall runs
 * electron-rebuild), which plain Node can't load. This script swaps in a
 * Node-ABI binary for the duration of the tests and restores the Electron
 * binary afterwards. Both binaries are cached, so the swap is a file copy.
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

function loadsUnderNode() {
  try {
    // eslint-disable-next-line global-require
    const Database = require('better-sqlite3')
    new Database(':memory:').close()
    return true
  } catch {
    return false
  }
}

function runVitest() {
  const args = process.argv.length > 2 ? process.argv.slice(2) : ['run']
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), ...args],
    { cwd: serverDir, stdio: 'inherit' },
  )
  return result.status ?? 1
}

let swapped = false
if (!loadsUnderNode()) {
  // Current binary is the Electron build — park it and bring in a Node build.
  fs.mkdirSync(cacheDir, { recursive: true })
  fs.copyFileSync(binaryPath, electronCache)
  if (fs.existsSync(nodeCache)) {
    fs.copyFileSync(nodeCache, binaryPath)
  } else {
    console.log('[run-tests] Building better-sqlite3 for Node (one-time)...')
    execSync('npm rebuild better-sqlite3', { cwd: root, stdio: 'inherit' })
    fs.copyFileSync(binaryPath, nodeCache)
  }
  swapped = true
}

let exitCode = 1
try {
  exitCode = runVitest()
} finally {
  if (swapped) {
    fs.copyFileSync(electronCache, binaryPath)
    console.log('[run-tests] Restored Electron build of better-sqlite3.')
  }
}
process.exit(exitCode)
