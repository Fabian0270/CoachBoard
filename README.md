# CoachBoard

A desktop application for strength coaches to manage athletes, build and analyze training programs, and exchange programs with Excel. Built with Electron, React, and SQLite — runs fully offline with no cloud dependency or account required.

---

## Features

- **Athlete management** — track athletes, their training maxes, and progress over time.
- **Program builder** — create multi-week programs with workouts, exercises, and per-set prescriptions; copy/move training days, reorder exercises, and adjust program duration.
- **Draft generation** — generate a starting draft program from an athlete's data and a built-in strength-training knowledge base (the coach always edits the final result).
- **Program analysis & reports** — per-program reports with volume/intensity breakdowns and side-by-side program comparison.
- **Excel import** — import existing programs from spreadsheets, including a tolerant parser for externally-formatted files.
- **Excel export & style templates** — export programs to polished `.xlsx` (choose CoachBoard, Minimalistic, or Modern built-in looks, or a coach's own imported style), preview the exact sheet before saving, and capture a coach's spreadsheet layout as a reusable export style so new programs match their house format.
- **Email delivery** — send a program's Excel sheet straight to an athlete's email from inside the app over SMTP, with the app password stored encrypted via the OS keychain.
- **Discord integration** — sync athlete video check-ins from a Discord server: parses lift captions, auto-suggests the matching programmed exercise, and lets the coach reply (channel or DM) from an in-app inbox. Bot token stored encrypted; fully optional.
- **Program bookmarking** — star programs to favorite them for reuse, with a filter to show bookmarked-only.
- **Calculators** — RPE cheat sheet, 1RM estimates, and warm-up set suggestions.
- **Payments** — track athlete payments and balances.
- **Dark mode** — Light / Dark / System theme toggle.

---

## Download & Install (End Users)

Go to the [Releases page](https://github.com/Fabian0270/CoachBoard/releases) and download the build for your OS:

**Windows**
1. Download **CoachBoard Setup x.x.x.exe** from the latest release
2. Run the installer and follow the prompts
3. Launch **CoachBoard** from the Start Menu or Desktop shortcut

**macOS** (Apple Silicon — M1/M2/M3/M4)
1. Download **CoachBoard-x.x.x-arm64.dmg**
2. Open the `.dmg` and drag **CoachBoard** into Applications
3. The current builds are not yet notarized, so on first launch **right-click the app → Open → Open** to get past Gatekeeper (only needed once)

> Intel Macs aren't supported yet — GitHub's free Intel build runners have been retired, so a native x64 build needs a paid runner or a self-hosted Intel Mac (tracked as a follow-up).

The app stores all data locally in your user profile (`%APPDATA%` on Windows, `~/Library/Application Support` on macOS). No account required and it runs fully offline — emailing a program to an athlete and syncing with Discord are the only optional features that use your internet connection.

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
| Discord sync | Plain-fetch REST v10 client (no SDK) |
| Tests | Vitest |

---

## Development Setup

### Prerequisites

- [Node.js](https://nodejs.org/) v20 or later
- npm v10 or later (comes with Node.js)
- Windows or macOS. `better-sqlite3` is a native module compiled per-platform, so a packaged build must be produced **on** its target OS — a Windows installer on Windows, a macOS `.dmg` on macOS. The [`Release` CI workflow](.github/workflows/release.yml) builds both on GitHub's runners when you push a version tag, so no Mac hardware is needed to ship them.

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

### Cutting a release (recommended)

Both installers are built by CI on a version tag, then attached to one GitHub Release:

```bash
# 1. bump the version in the workspace package.json files to match the tag
# 2. commit + merge to main, then:
git tag v1.14.0
git push --tags
```

The [`Release` workflow](.github/workflows/release.yml) builds the Windows `.exe`
(`windows-latest`) and the Apple Silicon `.dmg` (`macos-14`) in parallel and publishes a
single `v1.14.0` Release with both attached. The installer filenames embed the package.json
`version`, so **always bump the version to match the tag first.** Intel (x64) Macs aren't
built — GitHub's free Intel runners were retired; see the header note in
[`release.yml`](.github/workflows/release.yml) for how to add them back. Builds are unsigned:
Windows users click through SmartScreen, Mac users right-click → Open on first launch.

### Building installers locally

Each installer must be built **on** its target OS (native module compilation):

```bash
npm run package        # Windows → dist-electron/CoachBoard Setup x.x.x.exe (+ win-unpacked/)
npm run package:mac    # macOS   → dist-electron/CoachBoard-x.x.x-<arch>.dmg
```

---

## Project Structure

```
CoachBoard/
├── client/          # React frontend (Vite)
│   └── src/
│       ├── components/
│       ├── pages/    # Dashboard, Athletes, Programs, Calculators, Payments, Excel Styles, Settings, Discord Inbox
│       └── lib/
├── server/          # Express backend
│   └── src/
│       ├── routes/    # athletes, programs, progress, payments, style, exportStyles, settings, discord
│       ├── services/  # program/import/export/analysis/suggestion/payment/email/preview/discord logic
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
