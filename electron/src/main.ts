import {
  app,
  BrowserWindow,
  Menu,
  session,
  dialog,
  desktopCapturer,
  nativeTheme,
  safeStorage,
  shell,
} from 'electron'
import path from 'path'
import fs from 'fs'
import { createServer, type RequestListener } from 'http'
import { autoUpdater } from 'electron-updater'
import { createWindowTools, type WindowTools } from './minimizedWindows'

/**
 * Dev means "running from source", which is exactly what app.isPackaged says.
 *
 * This used to read NODE_ENV, which the dev script never set — so `npm run dev`
 * started Vite, then loaded the *built* bundle from the Express server instead.
 * There was no error: the app opened, and every edit silently did nothing
 * because the window was showing whatever the last `npm run build` produced. An
 * Electron window has no address bar either, so there was no way to see which
 * one you had. Deriving it removes the trap rather than documenting it.
 *
 * To exercise the built client, package it — see the packaging notes in
 * docs/ROADMAP.md for why that is the only trustworthy check anyway.
 */
const isDev = !app.isPackaged
/** Preferred port. The dev renderer's Vite proxy points here. */
const SERVER_PORT = 3001
/**
 * Where to look when the preferred port is taken. A fixed, ordered list rather
 * than "any free port", so a coach whose machine always has 3001 busy lands on
 * the same port every launch — browser storage (theme, onboarding progress) is
 * kept per origin, and a random port would start it empty every time.
 */
const FALLBACK_PORTS = [3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010]
/** The port the embedded server actually bound. */
let serverPort = SERVER_PORT

/**
 * The embedded server bundle, loaded at runtime from extraResources. Typed here
 * rather than left as the `any` a dynamic import produces, so a rename on the
 * server side fails the build instead of failing silently at launch.
 *
 * Members added after the first release are optional: a packaged app can be
 * running against a bundle built before they existed.
 */
interface ServerBundle {
  initializeDatabase(dbPath: string): Promise<void>
  createApp(staticDir: string, logPath: string): RequestListener
  /** Points the server's logger at the log file. Must run before initializeDatabase. */
  configureLogger?(path: string): void
  configureSecureStore(opts: { safeStorage: unknown; userDataDir: string }): void
  configureSystem?(opts: { shell: unknown }): void
  configureCapture?(opts: { desktopCapturer: unknown; ownSourceIds?: () => string[]; windowTools?: WindowTools | null }): void
  /** The source the coach picked, consumed once. See services/captureService. */
  resolvePendingSource?(): Promise<
    { kind: 'self' } | { kind: 'source'; source: Electron.DesktopCapturerSource } | null
  >
  configureUpdates?(opts: { install: () => void }): void
  setUpdateState?(state: { status: string; version?: string | null; message?: string | null }): void
  runStartupBackup?(): Promise<string | null>
  /** The settings half of a staged restore. Needs the keychain, so it runs
   *  after configureSecureStore rather than inside initializeDatabase. */
  applyPendingSettingsRestore?(dbPath: string): Promise<{
    restored: string[]
    secretsDropped: string[]
  } | null>
  sweepRecordings?(): Promise<number>
  sweepAnalysisVideos?(): Promise<number>
  sweepPartialMedia?(): Promise<number>
  initDiscordSync?(opts: { launchDelayMs: number }): void | Promise<void>
}

let serverBundle: ServerBundle | null = null

/** The app window, once created — the recorder leaves it out of the window list. */
let ownWindow: BrowserWindow | null = null

/** Set while the app is quitting, so the close guard can finish a quit it interrupted. */
let quitting = false
app.on('before-quit', () => {
  quitting = true
})

let logPath = ''

/** Roll the log past this size so it can't grow for the life of the install. */
const MAX_LOG_BYTES = 5 * 1024 * 1024

/** Best-effort rotation, keeping one previous generation. Never blocks logging. */
function rotateLogIfNeeded(): void {
  if (!logPath) return
  try {
    if (fs.statSync(logPath).size < MAX_LOG_BYTES) return
    fs.rmSync(`${logPath}.1`, { force: true })
    fs.renameSync(logPath, `${logPath}.1`)
  } catch {
    /* missing, locked, or unwritable — fall through and just append */
  }
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  if (logPath) {
    rotateLogIfNeeded()
    try { fs.appendFileSync(logPath, line) } catch { /* ignore */ }
  }
  console.log(msg)
}

function describeError(err: unknown): string {
  return err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err)
}

// ── Crash safety ────────────────────────────────────────────────────────────
// The Express server runs inside this process rather than as a child, so an
// unhandled throw anywhere takes the entire app down with it. There were no
// handlers at all, which meant that happened silently: no log line, no dialog,
// just a window that vanished.

let crashDialogShown = false

function reportCrash(kind: string, err: unknown): void {
  log(`${kind}: ${describeError(err)}`)

  // Surface only the first one. A repeating fault would otherwise bury the coach
  // in modal dialogs faster than they could dismiss them.
  if (crashDialogShown || !app.isReady()) return
  crashDialogShown = true
  void dialog
    .showMessageBox({
      type: 'error',
      title: 'CoachBoard hit an unexpected error',
      message: 'Something went wrong in the background.',
      detail:
        'Your data on disk is untouched. If the app starts behaving oddly, restart it.\n\n' +
        `Details were written to:\n${logPath}`,
      buttons: ['OK'],
    })
    .catch(() => { /* a failed dialog must not recurse back into this handler */ })
}

process.on('uncaughtException', (err) => reportCrash('UNCAUGHT EXCEPTION', err))

process.on('unhandledRejection', (reason) => {
  // Logged but deliberately not surfaced. Rejections happen in normal operation
  // (a dropped Discord fetch, an aborted request), so a dialog would cry wolf.
  log(`UNHANDLED REJECTION: ${describeError(reason)}`)
})

function resolveServerPath(relPath: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, relPath)
    : path.join(__dirname, '../../', relPath)
}

async function startServer(): Promise<void> {
  const dbPath = path.join(app.getPath('userData'), 'coachboard.sqlite')
  log(`DB path: ${dbPath}`)

  const bundlePath = resolveServerPath('server/dist/electron-bundle.cjs')
  log(`Bundle path: ${bundlePath} (exists: ${fs.existsSync(bundlePath)})`)

  const bundle = (await import(bundlePath as string)) as ServerBundle
  serverBundle = bundle
  // Before the database opens: migrations and restores log during
  // initializeDatabase, and until now that went to a console a packaged app
  // does not have — the log file only got connected later, in createApp.
  bundle.configureLogger?.(logPath)
  log('Bundle loaded, initializing database...')

  await bundle.initializeDatabase(dbPath)
  log('Database initialized')

  // Rolling backup of the database the coach just opened, keeping the last few.
  // Best-effort inside the service — a backup failure must never block startup.
  const backup = await bundle.runStartupBackup?.()
  if (backup) log(`Startup backup: ${backup}`)

  const staticDir = resolveServerPath('client/dist')
  log(`Static dir: ${staticDir} (exists: ${fs.existsSync(staticDir)})`)

  // Give the server access to Electron-owned secure storage (DPAPI) + the real
  // userData path so it can persist the encrypted email app-password (Feature 6a).
  bundle.configureSecureStore({ safeStorage, userDataDir: app.getPath('userData') })

  // The settings half of a restore, which the database half (inside
  // initializeDatabase) cannot do: deciding whether to keep or drop a restored
  // credential means attempting a decrypt, and safeStorage only exists from the
  // line above. Same machine, the app password survives; anywhere else it is
  // undecryptable bytes and gets dropped rather than left to fail at send time.
  const settingsRestore = await bundle.applyPendingSettingsRestore?.(dbPath)
  if (settingsRestore?.restored.length) {
    log(`Restored settings: ${settingsRestore.restored.join(', ')}`)
    if (settingsRestore.secretsDropped.length) {
      log(`Credentials dropped (not from this machine): ${settingsRestore.secretsDropped.join(', ')}`)
    }
  }

  // Same injection seam for the handful of shell actions the UI needs (opening
  // the data folder from Settings and from the error screen). Optional-chained so
  // a stale bundle without the export can't break startup.
  bundle.configureSystem?.({ shell })
  // From Electron 45 the window list includes our own window, which the picker
  // already offers as "CoachBoard" (captured by frame, see the display handler).
  bundle.configureCapture?.({
    desktopCapturer,
    ownSourceIds: () => (ownWindow && !ownWindow.isDestroyed() ? [ownWindow.getMediaSourceId()] : []),
    // Minimised windows, which Electron does not list (Windows only; null elsewhere).
    windowTools: createWindowTools(log),
  })

  // Feedback recordings are scratch space: the coach keeps one only by saving or
  // sending it. Anything still on disk after a restart is therefore abandoned —
  // an interrupted recording, or a review dialog that was never answered — and
  // keeping it would grow their disk with files they already declined. Needs
  // configureSecureStore above for the userData path.
  const swept = await bundle.sweepRecordings?.().catch(() => 0)
  if (swept) log(`Swept ${swept} abandoned recording(s)`)

  // Analysis videos are the opposite of recordings — kept until the coach
  // deletes the analysis — so this only collects files whose row is already
  // gone. It exists because deleting a file can fail while a player holds it
  // open on Windows, which would otherwise strand it forever.
  const orphans = await bundle.sweepAnalysisVideos?.().catch(() => 0)
  if (orphans) log(`Swept ${orphans} orphaned analysis video(s)`)

  // Half-written uploads and downloads. Safe only here, before the server is
  // listening: nothing can be in flight yet. See mediaStore.sweepPartialMedia.
  const partials = await bundle.sweepPartialMedia?.().catch(() => 0)
  if (partials) log(`Swept ${partials} abandoned partial file(s)`)

  const expressApp = bundle.createApp(staticDir, logPath)

  // A fixed port used to mean "CoachBoard failed to start" whenever anything
  // else on the machine held 3001 — another dev server, another app. The
  // single-instance lock already rules out a second CoachBoard, so a busy port
  // is always someone else's, and the next one in the list will do. Dev keeps
  // 3001 only: the Vite proxy is wired to it.
  const candidates = isDev ? [SERVER_PORT] : [SERVER_PORT, ...FALLBACK_PORTS]
  for (const [i, port] of candidates.entries()) {
    try {
      await new Promise<void>((resolve, reject) => {
        const server = createServer(expressApp)
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject)
          server.on('error', (err) => log(`Server error: ${err}`))
          resolve()
        })
      })
      serverPort = port
      log(`Server listening on port ${port}`)
      break
    } catch (err) {
      const busy = (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
      log(`Port ${port} unavailable: ${describeError(err)}`)
      if (!busy || i === candidates.length - 1) throw err
    }
  }

  // Discord sync-on-launch (delayed so startup isn't blocked; no-op when the
  // integration isn't configured). Optional-chained so a stale bundle without
  // the export can't crash startup.
  //
  // Fire-and-forget by design, but it previously had no catch at all: a rejection
  // here became an unhandled rejection that could take the main process down long
  // after a successful launch. The IIFE catches a synchronous throw too.
  void (async () => {
    try {
      await bundle.initDiscordSync?.({ launchDelayMs: 8000 })
    } catch (err) {
      log(`Discord sync failed to start: ${describeError(err)}`)
    }
  })()
}

/**
 * Auto-update, deliberately quiet.
 *
 * This is an offline-first app: a coach with no internet, or at a meet on a phone
 * hotspot, must never be blocked or nagged. Every failure here is a logged no-op,
 * and the only thing the coach ever sees is an optional "restart to update" once
 * a new version has already downloaded.
 */
function initAutoUpdate(): void {
  // electron-updater throws outside a packaged app — there is nothing to update.
  if (!app.isPackaged) return

  // Squirrel.Mac refuses to install an update unless the app bundle is signed,
  // and the macOS build is forced unsigned until an Apple Developer ID exists.
  // Checking anyway would just error on every launch, so skip it entirely.
  if (process.platform === 'darwin') {
    log('Auto-update skipped: macOS builds are unsigned (see docs/CODE_SIGNING.md)')
    return
  }

  const bundle = serverBundle
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    log(`Update available: ${info.version}`)
    bundle?.setUpdateState?.({ status: 'downloading', version: info.version })
  })
  autoUpdater.on('update-not-available', () => {
    bundle?.setUpdateState?.({ status: 'idle' })
  })
  autoUpdater.on('update-downloaded', (info) => {
    log(`Update downloaded and staged: ${info.version}`)
    bundle?.setUpdateState?.({ status: 'ready', version: info.version })
  })
  autoUpdater.on('error', (err) => {
    // Being offline lands here. It is normal, so it stays in the log only.
    log(`Auto-update error: ${describeError(err)}`)
    bundle?.setUpdateState?.({ status: 'error', message: err?.message ?? 'unknown' })
  })

  bundle?.configureUpdates?.({ install: () => autoUpdater.quitAndInstall() })

  const check = (): void => {
    bundle?.setUpdateState?.({ status: 'checking' })
    void autoUpdater.checkForUpdates().catch((err: unknown) => {
      log(`Auto-update check failed: ${describeError(err)}`)
      bundle?.setUpdateState?.({ status: 'error', message: 'check failed' })
    })
  }

  check()

  // electron-updater does not poll on its own, and this only ever ran once at
  // launch — so a coach who leaves CoachBoard open for a week never learned a
  // release existed. Six hours means they have it within a working day while
  // staying well inside the "deliberately quiet" posture above: every failure is
  // still a logged no-op, and the only visible outcome is the optional
  // restart-to-update banner once something has already downloaded.
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000
  const timer = setInterval(check, SIX_HOURS_MS)
  // Without this the interval keeps the event loop alive and delays quit.
  app.on('before-quit', () => clearInterval(timer))
}

/**
 * Screen capture and camera/mic permissions for Feature 11c.
 *
 * The roadmap originally rejected getDisplayMedia for 11c in favour of
 * canvas.captureStream(). That only ever worked for the bar-path overlay: the
 * recorder also has to capture program pages, the Excel preview — and now any
 * window the coach picks — none of which live in a canvas. The macOS Screen
 * Recording prompt that argument was avoiding is a cost we take instead, and
 * Windows is the only shipping target today.
 */
function configureMediaHandlers(sess: Electron.Session, win: BrowserWindow): void {
  // Only our own page may ask, and only for what the app actually uses.
  // Electron's default handler grants far more, and leaving camera and
  // microphone to an undocumented default is not a decision worth inheriting.
  //
  // Clipboard is on the list because two real call sites depend on it — copying
  // the Discord invite URL, and the error screen's copy-details button. A
  // blanket media-only allowlist silently breaks both.
  // 'fullscreen' is here because the spike caught it being denied the moment a
  // recording was played back — the <video> fullscreen button goes through this
  // handler, and so does the Excel preview. Exactly the case the logging below
  // exists to surface.
  //
  // 'display-capture' is screen and window capture — the recorder. Until
  // Electron 45 Chromium reported it as 'media' (with an empty mediaTypes
  // list); from 45 it arrives under its own name, and without it here every
  // screen recording would be refused while camera and microphone still worked.
  const ALLOWED = new Set([
    'media',
    'display-capture',
    'clipboard-write',
    'clipboard-sanitized-write',
    'fullscreen',
  ])

  sess.setPermissionRequestHandler((contents, permission, callback) => {
    const granted = ALLOWED.has(permission) && isOwnOrigin(contents.getURL())
    // Logged rather than swallowed: a permission we did not anticipate should
    // show up as a line in the log, not as a feature that mysteriously stopped.
    if (!granted) log(`Permission denied: ${permission} for ${contents.getURL()}`)
    callback(granted)
  })

  // The synchronous sibling of the above: Chromium consults this for permission
  // *checks* (e.g. enumerateDevices labels) without a user gesture.
  sess.setPermissionCheckHandler((_contents, permission, origin) =>
    ALLOWED.has(permission) && isOwnOrigin(origin),
  )

  sess.setDisplayMediaRequestHandler(
    (_request, callback) => {
      // useSystemPicker stays on so this handler is skipped wherever the OS does
      // provide a picker (recent macOS). It did NOT engage on Windows in
      // Electron 33 — measured during the 11c spike, where every capture landed
      // here — so on Windows the app's own picker is the real path, and the
      // source it parked is what gets recorded.
      //
      // The callback is one-shot and must be answered exactly once. Refusal is
      // `null`: from Electron 45 `{ video: undefined }` throws ("video must be a
      // WebFrameMain or DesktopCapturerSource"), and the catch below then
      // answered a second time — an unhandled error in the main process.
      let answered = false
      const answer = (streams: Electron.Streams | null): void => {
        if (answered) return
        answered = true
        callback(streams)
      }
      const pending = serverBundle?.resolvePendingSource?.()
      if (!pending) {
        // No server bundle (or one without the picker): nothing can have been
        // chosen. Answering keeps the capture from hanging forever.
        log('Display capture refused: the source picker is unavailable')
        answer(null)
        return
      }
      pending
        .then((chosen) => {
          if (!chosen) {
            // No choice parked: the request did not come from our picker, or the
            // window the coach chose has since closed. Refusing is the honest
            // answer — defaulting to the whole screen would record something
            // they never agreed to share.
            log('Display capture refused: no source was chosen')
            answer(null)
            return
          }
          // 'loopback' mixes the machine's own audio in, so a lift video's sound
          // survives into the recording. Confirmed working on Windows.
          if (chosen.kind === 'self') {
            // Electron's window enumeration omits our own windows, so recording
            // CoachBoard — the whole point of the program-walkthrough half of
            // 11c — is done by capturing the frame rather than the window.
            // Also strictly better: nothing overlapping the window can bleed in.
            log('Display capture: CoachBoard (frame)')
            answer({ video: win.webContents.mainFrame, audio: 'loopback' })
            return
          }
          log(`Display capture: ${chosen.source.name}`)
          answer({ video: chosen.source as Electron.Video, audio: 'loopback' })
        })
        .catch((err: unknown) => {
          log(`Display capture failed: ${describeError(err)}`)
          answer(null)
        })
    },
    { useSystemPicker: true },
  )
}

/**
 * Dev serves the renderer from :3000, production from the embedded server —
 * on whichever port it actually bound, so this is read after startServer.
 */
const appOrigin = (): string => (isDev ? 'http://localhost:3000' : `http://localhost:${serverPort}`)

/**
 * Whether a URL is the app's own page.
 *
 * Exact origin, not "any localhost". The looser check granted camera,
 * microphone and clipboard to any page served from ANY local port — another
 * dev server, or a page the window had been navigated to.
 */
function isOwnOrigin(url: string): boolean {
  try {
    return new URL(url).origin === appOrigin()
  } catch {
    return false
  }
}

async function createWindow(): Promise<void> {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* blob: data:; " +
            // Discord user avatars in the inbox come straight from Discord's CDN.
            "img-src 'self' http://localhost:* blob: data: https://cdn.discordapp.com",
        ],
      },
    })
  })

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    autoHideMenuBar: true,
    // Dev only. A packaged build takes its window and taskbar icon from the
    // executable, which electron-builder stamps from build/icon.png — but an
    // unpackaged `electron .` has no such exe and falls back to the default
    // Electron atom, so the icon is passed explicitly here. __dirname is
    // electron/dist at runtime, hence ../build.
    ...(app.isPackaged ? {} : { icon: path.join(__dirname, '../build/icon.png') }),
    // Match the app's light/dark background during load to avoid a white flash.
    // Approximates the renderer's "system" default; values mirror --background in index.css.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  ownWindow = win

  // Needs the window: recording CoachBoard itself captures its frame, not a
  // desktopCapturer source. Handlers only have to exist before the first
  // getDisplayMedia call, which is long after load.
  configureMediaHandlers(session.defaultSession, win)

  // Keep a standard Edit menu so the copy/cut/paste/select-all keyboard
  // accelerators keep working (a null menu disables them). autoHideMenuBar keeps
  // the bar itself hidden; Alt still reveals it.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }]))

  // Right-click copy/paste in any text field or over selected text.
  win.webContents.on('context-menu', (_event, params) => {
    if (!params.isEditable && !params.selectionText) return
    const { editFlags } = params
    const template: Electron.MenuItemConstructorOptions[] = [
      { role: 'cut', enabled: editFlags.canCut },
      { role: 'copy', enabled: editFlags.canCopy },
      { role: 'paste', enabled: editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: editFlags.canSelectAll },
    ]
    Menu.buildFromTemplate(template).popup({ window: win })
  })

  // Open external links (e.g. the Google app-password setup links in Settings)
  // in the system browser instead of a blank in-app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // The same rule for navigation in place. Without it, a link without
  // target=_blank — or a redirect — replaced the app with whatever it pointed
  // at, inside a window that holds camera, microphone and screen-capture
  // grants and has no address bar to show where it had gone. External links go
  // to the system browser instead; hash routing never fires this event.
  const keepInApp = (event: Electron.Event, url: string): void => {
    if (isOwnOrigin(url)) return
    event.preventDefault()
    log(`Blocked navigation away from the app: ${url}`)
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  }
  win.webContents.on('will-navigate', keepInApp)
  win.webContents.on('will-redirect', keepInApp)
  // The app never uses <webview>, and one would be a second, unguarded window.
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())

  // The close guard. A page with work in flight — a recording, a video upload,
  // program edits that have not saved — asks the browser not to unload, and
  // Electron then cancels the close SILENTLY: the window just would not shut.
  // This is the documented hook for asking instead.
  //
  // Asked WITHOUT blocking. This used showMessageBoxSync, which halts the main
  // process until answered — and the main process produces the frames when
  // CoachBoard records itself and receives every uploaded chunk, so a recording
  // froze for as long as the question was on screen. Not calling
  // preventDefault() cancels this close straight away; the question is then
  // asked asynchronously, and "Close anyway" closes the window directly
  // (destroy() skips beforeunload, so it cannot ask a second time).
  let asking = false
  win.webContents.on('will-prevent-unload', () => {
    if (asking) return // a second click on × while the question is already up
    asking = true
    const quitWasRequested = quitting
    void dialog
      .showMessageBox(win, {
        type: 'warning',
        buttons: ['Close anyway', 'Keep working'],
        defaultId: 1,
        cancelId: 1,
        title: 'CoachBoard',
        message: 'CoachBoard is still working on something.',
        detail:
          'A recording, a video upload, or program changes that have not saved yet would be lost if you close now.',
      })
      .then(({ response }) => {
        if (response !== 0) {
          quitting = false
          return
        }
        if (!win.isDestroyed()) win.destroy()
        // A quit (Cmd+Q, or installing an update) was what asked to close. On
        // Windows the app quits with its last window anyway; on macOS it would
        // otherwise stay running with no window.
        if (quitWasRequested) app.quit()
      })
      .catch((err: unknown) => log(`Close confirmation failed: ${describeError(err)}`))
      .finally(() => {
        asking = false
      })
  })

  await win.loadURL(appOrigin())
  if (isDev) win.webContents.openDevTools()
}

// A second instance would fail to bind the server port — focus the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

app.whenReady().then(async () => {
  logPath = path.join(app.getPath('userData'), 'coachboard.log')
  log(`CoachBoard starting — packaged: ${app.isPackaged}, resourcesPath: ${process.resourcesPath}`)
  try {
    await startServer()
    await createWindow()
    // After the window exists: the check is background work and must never sit
    // between the coach and their app opening.
    initAutoUpdate()
  } catch (err) {
    log(`FATAL: ${describeError(err)}`)
    // Lead with the readable message; the stack is in the log, not the dialog.
    const message = err instanceof Error ? err.message : String(err)
    dialog.showErrorBox(
      'CoachBoard failed to start',
      `${message}\n\nYour data has not been touched. Full details were written to:\n${logPath}`,
    )
    app.quit()
  }
})

// A dead renderer presents as a frozen or blank window with no other signal, so
// record why. Child processes (GPU, utility) are usually recoverable — log only.
app.on('render-process-gone', (_event, _webContents, details) => {
  log(`RENDERER GONE: reason=${details.reason} exitCode=${details.exitCode}`)
})

app.on('child-process-gone', (_event, details) => {
  log(`CHILD PROCESS GONE: type=${details.type} reason=${details.reason}`)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
