import { app, BrowserWindow, Menu, session, dialog, nativeTheme, safeStorage, shell } from 'electron'
import path from 'path'
import fs from 'fs'
import { createServer } from 'http'

const isDev = process.env.NODE_ENV === 'development'
const SERVER_PORT = 3001

let logPath = ''

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  if (logPath) try { fs.appendFileSync(logPath, line) } catch { /* ignore */ }
  console.log(msg)
}

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
}

async function createWindow(): Promise<void> {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:* blob: data:",
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

  win.setMenu(null)
  Menu.setApplicationMenu(null)

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
    const msg = err instanceof Error ? `${err.message}\n\n${err.stack}` : String(err)
    log(`FATAL: ${msg}`)
    dialog.showErrorBox('CoachBoard failed to start', msg)
    app.quit()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
