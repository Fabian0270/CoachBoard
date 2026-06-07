# CoachBoard

A desktop application for coaches to manage athletes, training programs, and progress tracking. Built with Electron, React, and SQLite — runs fully offline with no cloud dependency.

---

## Download & Install (End Users)

1. Go to the [Releases page](https://github.com/Fabian0270/CoachBoard/releases)
2. Download **CoachBoard Setup x.x.x.exe** from the latest release
3. Run the installer and follow the prompts
4. Launch **CoachBoard** from the Start Menu or Desktop shortcut

The app stores all data locally in your user profile (`%APPDATA%\CoachBoard`). No account or internet connection required.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron |
| Frontend | React 18, Vite, Tailwind CSS |
| Backend | Express (embedded, localhost only) |
| Database | SQLite via better-sqlite3 + Kysely |
| Charts | Recharts |
| Excel export | ExcelJS |

---

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v20 or later
- npm v10 or later (comes with Node.js)
- Windows (the native SQLite build targets Win x64)

### 1. Clone the repo

```bash
git clone https://github.com/Fabian0270/CoachBoard.git
cd CoachBoard
```

### 2. Install dependencies

```bash
npm install
```

This also runs `electron-rebuild` automatically (via `postinstall`) to compile the native `better-sqlite3` module for your Electron version.

### 3. Start in development mode

```bash
npm run dev
```

This starts three things concurrently:
- **Server** — builds the Express bundle, then watches for changes
- **Client** — Vite dev server on `http://localhost:3000`
- **Electron** — waits for the client to be ready, then opens the app window

The Electron window connects to the Vite dev server, so React hot-reload works normally.

---

## Building

### Build client + server (no Electron packaging)

```bash
npm run build
```

Outputs:
- `client/dist/` — Vite production build
- `server/dist/electron-bundle.cjs` — esbuild bundle of the Express server

### Package as a Windows installer

```bash
npm run package
```

Outputs to `dist-electron/`:
- `CoachBoard Setup x.x.x.exe` — NSIS installer (~74 MB)
- `win-unpacked/` — unpacked app directory (~244 MB)

---

## Project Structure

```
CoachBoard/
├── client/          # React frontend (Vite)
│   └── src/
│       ├── components/
│       ├── pages/
│       └── lib/
├── server/          # Express backend
│   └── src/
│       ├── routes/  # athletes, programs, progress
│       ├── db.ts    # Kysely + SQLite setup
│       └── app.ts   # Express app factory
├── electron/        # Electron main process
│   └── src/
│       └── main.ts  # starts Express, opens BrowserWindow
└── package.json     # npm workspaces root
```

The app runs Express on `localhost:3001` inside the Electron process. The React frontend talks to it via the `/api/*` routes. SQLite data is stored at `%APPDATA%\CoachBoard\coachboard.sqlite`.
