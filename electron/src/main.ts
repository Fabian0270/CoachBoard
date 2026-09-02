import { app, BrowserWindow, Menu, session, dialog, nativeTheme, safeStorage, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import { createServer } from 'http'

const isDev = process.env.NODE_ENV === 'development'
const SERVER_PORT = 3001

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

  const bundle = await import(bundlePath as string)
  log('Bundle loaded, initializing database...')

  await bundle.initializeDatabase(dbPath)
  log('Database initialized')

  const staticDir = resolveServerPath('client/dist')
  log(`Static dir: ${staticDir} (exists: ${fs.existsSync(staticDir)})`)

  // Give the server access to Electron-owned secure storage (DPAPI) + the real
  // userData path so it can persist the encrypted email app-password (Feature 6a).
  bundle.configureSecureStore({ safeStorage, userDataDir: app.getPath('userData') })

  const expressApp = bundle.createApp(staticDir, logPath)

  await new Promise<void>((resolve, reject) => {
    const server = createServer(expressApp)
    server.listen(SERVER_PORT, '127.0.0.1', () => {
      log(`Server listening on port ${SERVER_PORT}`)
      resolve()
    })
    server.on('error', (err) => {
      log(`Server error: ${err}`)
      reject(err)
    })
  })

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
    // Match the app's light/dark background during load to avoid a white flash.
    // Approximates the renderer's "system" default; values mirror --background in index.css.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

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

  if (isDev) {
    await win.loadURL('http://localhost:3000')
    win.webContents.openDevTools()
  } else {
    await win.loadURL(`http://localhost:${SERVER_PORT}`)
  }
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
