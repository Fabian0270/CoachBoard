# CoachBoard

A desktop application for strength coaches to manage athletes, build and analyze training programs, and exchange programs with Excel. Built with Electron, React, and SQLite — runs fully offline with no cloud dependency or account required.

---

## Features

- **Athlete management** — track athletes, their training maxes, and progress over time.
- **Program builder** — create multi-week programs with workouts, exercises, and per-set prescriptions; copy/move training days, reorder exercises, and adjust program duration.
- **Draft generation** — generate a starting draft program from an athlete's data and a built-in strength-training knowledge base (the coach always edits the final result).
- **Program analysis & reports** — per-program reports with volume/intensity breakdowns and side-by-side program comparison.
- **Excel import** — import existing programs from spreadsheets, including a tolerant parser for externally-formatted files.
- **Excel export & style templates** — export programs to polished `.xlsx`, preview the exact sheet before saving, and capture a coach's spreadsheet layout as a reusable export style so new programs match their house format.
- **Email delivery** — send a program's Excel sheet straight to an athlete's email from inside the app over SMTP, with the app password stored encrypted via the OS keychain.
- **Calculators** — RPE cheat sheet, 1RM estimates, and warm-up set suggestions.
- **Payments** — track athlete payments and balances.
- **Dark mode** — Light / Dark / System theme toggle.

---

## Download & Install (End Users)

1. Go to the [Releases page](https://github.com/Fabian0270/CoachBoard/releases)
2. Download **CoachBoard Setup x.x.x.exe** from the latest release
3. Run the installer and follow the prompts
4. Launch **CoachBoard** from the Start Menu or Desktop shortcut

The app stores all data locally in your user profile (`%APPDATA%`). No account required and it runs fully offline — emailing a program to an athlete is the one optional feature that uses your internet connection.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron |
| Frontend | React 18, Vite, Tailwind CSS, React Router |
| Backend | Express (embedded, localhost only) |
| Database | SQLite via better-sqlite3 + Kysely |
| Validation | Zod |
| Charts | Recharts |
| Excel import/export | ExcelJS |
| Email delivery | Nodemailer (SMTP) |
| Tests | Vitest |

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

### Useful scripts

```bash
npm run typecheck   # tsc --noEmit across client + server
npm test            # Vitest suites for client + server
```

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
- `CoachBoard Setup x.x.x.exe` — NSIS installer
- `win-unpacked/` — unpacked app directory

---

## Project Structure

```
CoachBoard/
├── client/          # React frontend (Vite)
│   └── src/
│       ├── components/
│       ├── pages/    # Dashboard, Athletes, Programs, Calculators, Payments, Excel Styles, Settings
│       └── lib/
├── server/          # Express backend
│   └── src/
│       ├── routes/    # athletes, programs, progress, payments, style, exportStyles, settings
│       ├── services/  # program/import/export/analysis/suggestion/payment/email/preview logic
│       ├── db.ts      # Kysely + SQLite setup
│       └── app.ts     # Express app factory
├── shared/          # Code shared by client + server
│                    # rpe, exercises, knowledge, payments, scoring, warmup, exportLayout, types
├── electron/        # Electron main process
│   └── src/
│       └── main.ts  # starts Express, opens BrowserWindow
└── package.json     # npm workspaces root (client, server, shared, electron)
```

The app runs Express on `localhost:3001` inside the Electron process. The React frontend talks to it via the `/api/*` routes. SQLite data is stored in the app's `userData` directory under `%APPDATA%`.
