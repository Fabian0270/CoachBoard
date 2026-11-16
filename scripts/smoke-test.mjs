#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Launch a packaged CoachBoard and check that it actually works.
//
//   node scripts/smoke-test.mjs <path to the app's executable>
//
// Every packaging bug so far was invisible to typecheck, the tests and CI:
// a missing module that killed the app before it could log anything, an
// installer name the updater could not find. Both only showed up by running
// the built app. This runs it — with its own empty data folder, so it never
// touches anyone's data — waits for the embedded server, and asks it for a
// few things only a working build can answer:
//
//   - the database opened and the API answers (an empty athlete list);
//   - the data folder is the throwaway one (the test is really isolated);
//   - the client was bundled (index.html and the script it loads).
//
// Exits 0 when all of that holds, 1 otherwise, printing the app's log.
// ---------------------------------------------------------------------------
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const exe = process.argv[2]
if (!exe || !existsSync(exe)) {
  console.error(`Usage: node scripts/smoke-test.mjs <path to the packaged app's executable>\nNot found: ${exe}`)
  process.exit(1)
}

const START_TIMEOUT_MS = 90_000
const userData = mkdtempSync(join(tmpdir(), 'coachboard-smoke-'))
const logPath = join(userData, 'coachboard.log')
const readLog = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '(no log file was written)')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ELECTRON_RUN_AS_NODE turns Electron into plain Node, and the app then dies
// at its first line without a log. Some shells set it; the app never wants it.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(exe, [`--user-data-dir=${userData}`], { env, stdio: 'ignore', detached: process.platform !== 'win32' })
let exited = null
child.on('exit', (code, signal) => { exited = { code, signal } })

const stop = () => {
  if (exited) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGKILL') // the whole group: Electron's helpers too
  } catch { /* already gone */ }
}

const fail = (why) => {
  console.error(`\nSMOKE TEST FAILED: ${why}\n\n--- coachboard.log ---\n${readLog()}`)
  stop()
  process.exit(1)
}

try {
  // 1. The embedded server says which port it took (it falls back from 3001).
  let port = null
  const deadline = Date.now() + START_TIMEOUT_MS
  while (!port) {
    if (exited) fail(`the app exited during start-up (${JSON.stringify(exited)})`)
    if (Date.now() > deadline) fail(`no "Server listening" line within ${START_TIMEOUT_MS / 1000}s`)
    const m = readLog().match(/Server listening on port (\d+)/)
    if (m) port = Number(m[1])
    else await sleep(500)
  }
  if (/FATAL/.test(readLog())) fail('the log has a FATAL line')
  const base = `http://127.0.0.1:${port}`
  console.log(`App started; server on ${base}`)

  const get = async (path) => {
    const res = await fetch(base + path)
    return { status: res.status, type: res.headers.get('content-type') ?? '', text: await res.text() }
  }

  // 2. The database opened and the API answers.
  const athletes = await get('/api/athletes')
  if (athletes.status !== 200) fail(`/api/athletes answered ${athletes.status}`)
  let list
  try { list = JSON.parse(athletes.text) } catch { fail(`/api/athletes did not answer JSON: ${athletes.text.slice(0, 200)}`) }
  if (!Array.isArray(list) || list.length !== 0) fail(`a fresh data folder should have no athletes, got ${athletes.text.slice(0, 200)}`)
  console.log('API answers; database opened')

  // 3. It really is using the throwaway folder.
  const paths = await get('/api/system/paths')
  if (paths.status !== 200) fail(`/api/system/paths answered ${paths.status}`)
  const dataDir = JSON.parse(paths.text).dataDir ?? ''
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase()
  if (!norm(dataDir).endsWith(norm(userData).split('/').pop())) fail(`the app is using ${dataDir}, not the test folder ${userData}`)
  console.log(`Data folder is the test one: ${dataDir}`)

  // 4. The client was bundled: the page and the script it loads.
  const page = await get('/')
  if (page.status !== 200 || !page.text.includes('id="root"')) fail(`"/" did not serve the app page (${page.status})`)
  const script = page.text.match(/<script[^>]+src="([^"]+\.js)"/)?.[1]
  if (!script) fail('index.html names no script')
  const js = await get(script.startsWith('/') ? script : `/${script}`)
  if (js.status !== 200 || !/javascript/.test(js.type)) fail(`the client script ${script} answered ${js.status} ${js.type}`)
  console.log(`Client bundle served (${script}, ${Math.round(js.text.length / 1024)} KB)`)

  console.log('\nSMOKE TEST PASSED')
} finally {
  stop()
  // Give Windows a moment to let go of the database file before deleting it.
  await sleep(1500)
  try { rmSync(userData, { recursive: true, force: true }) } catch { /* left in tmp; harmless */ }
}
