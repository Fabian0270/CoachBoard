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
- **Discord integration** — sync athlete video check-ins from a Discord server: parses lift captions, auto-suggests the matching programmed exercise, and lets the coach reply (channel or DM) from an in-app inbox. Videos show a real poster frame and duration rather than a placeholder. Bot token stored encrypted; fully optional.
- **Bar path analysis** — track the bar through a lift on any clip, from your computer or from an athlete's Discord check-in. Click the bar and optical-flow tracking follows it, drawing the path live and reporting per-rep concentric velocity, range of motion and duration. Local files are never uploaded — the analyser runs entirely in the app.
- **Velocity-based training** — turn that bar speed into decisions: estimated RPE for the last rep against published per-lift references, agreement with the RPE the athlete called, an estimated 1RM from a single set, a fitted load–velocity profile across several loads, and velocity loss with the caveat that decides whether to read it. The athlete's own tracked history replaces the published references as it accumulates.
- **Program bookmarking** — star programs to favorite them for reuse, with a filter to show bookmarked-only.
- **Calculators** — RPE cheat sheet, 1RM estimates, and warm-up set suggestions.
- **Payments** — track athlete payments and balances.
- **Backup & restore** — save a copy of the database from Settings and restore it later; automatic backups are kept alongside it.
- **Auto-update** (Windows) — new versions download quietly in the background and install on restart or on quit. macOS updates stay off until the app is code-signed.
- **Dark mode** — Light / Dark / System theme toggle.

---

## Download & Install (End Users)

Go to the [Releases page](https://github.com/Fabian0270/CoachBoard/releases) and download the build for your OS:

**Windows**
1. Download **CoachBoard-Setup-x.x.x.exe** from the latest release
2. Run the installer and follow the prompts
3. Launch **CoachBoard** from the Start Menu or Desktop shortcut

**macOS** (Apple Silicon — M1/M2/M3/M4)
1. Download **CoachBoard-x.x.x-arm64.dmg**
2. Open the `.dmg` and drag **CoachBoard** into Applications
3. The current builds are not yet notarized, so on first launch **right-click the app → Open → Open** to get past Gatekeeper (only needed once)

> Intel Macs aren't supported yet — GitHub's free Intel build runners have been retired, so a native x64 build needs a paid runner or a self-hosted Intel Mac (tracked as a follow-up).

The app stores all data locally in a single folder named `coachboard-electron` inside your user profile — `%APPDATA%\coachboard-electron` on Windows, `~/Library/Application Support/coachboard-electron` on macOS. That folder holds the database, the log, automatic backups, and any synced Discord media. **Settings → Your data** shows the exact path, opens the folder, and lets you save or restore a copy of the database. No account required and it runs fully offline — emailing a program to an athlete and syncing with Discord are the only optional features that use your internet connection.

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
| Bar path tracking | opencv.js (vendored, Lucas–Kanade optical flow) in a Web Worker |
| Auto-update | electron-updater (GitHub provider) |
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
npm run typecheck     # tsc --noEmit across client, server and electron
npm test              # Vitest suites for client + server
npm run sqlite:repair # rebuild the native better-sqlite3 binding if it breaks
```

`better-sqlite3` is a native addon built for one ABI: the app runs it under
Electron, the tests under plain Node. The server suite goes through
[`server/scripts/run-tests.cjs`](server/scripts/run-tests.cjs), which builds a
Node-ABI copy into `node_modules/.cache` once and points the tests at it —
`node_modules` keeps its Electron build and is never written to during a run.

---

## Building

### Build client + server (no Electron packaging)

```bash
npm run build
```

Outputs:
- `client/dist/` — Vite production build
- `server/dist/electron-bundle.cjs` — esbuild bundle of the Express server

### Cutting a release

From `main` (with your release work merged in), run one command:

```bash
npm run release 1.15.0
```

[`scripts/release.mjs`](scripts/release.mjs) bumps the version across every workspace, syncs
the lockfile, commits (`Bump version to 1.15.0`), pushes, then tags `v1.15.0` and pushes the
tag. It refuses to run (before changing anything) if the tree is dirty, you're not on `main`,
the version is unchanged, or the tag already exists.

Pushing the tag triggers the [`Release` workflow](.github/workflows/release.yml), which builds
the Windows `.exe` (`windows-latest`) and the Apple Silicon `.dmg` (`macos-14`) in parallel and
publishes a single `v1.15.0` Release with both attached. Because the script derives the tag,
commit, and installer filenames from the same version, they always stay in sync. Intel (x64)
Macs aren't built — GitHub's free Intel runners were retired; see the header note in
[`release.yml`](.github/workflows/release.yml) for how to add them back. Builds are unsigned:
Windows users click through SmartScreen, Mac users right-click → Open on first launch.

### Building installers locally

Each installer must be built **on** its target OS (native module compilation):

```bash
npm run package        # Windows → dist-electron/CoachBoard-Setup-x.x.x.exe (+ win-unpacked/)
npm run package:mac    # macOS   → dist-electron/CoachBoard-x.x.x-<arch>.dmg
```

---

## Project Structure

```
CoachBoard/
├── client/            # React frontend (Vite)
│   ├── public/
│   │   └── vendor/opencv/   # vendored opencv.js — bundled, not fetched, so it works offline
│   └── src/
│       ├── components/
│       │   └── analysis/    # bar-path stage, frame capture, tracker worker, velocity panel
│       ├── pages/    # Dashboard, Athletes, Programs, Calculators, Payments,
│       │             # Excel Styles, Settings, Discord Inbox, Bar path
│       └── lib/
├── server/            # Express backend
│   └── src/
│       ├── routes/    # athletes, programs, progress, payments, style, exportStyles,
│       │              # exportTemplates, settings, discord, analysis, backup, system
│       ├── services/  # program/import/export/analysis/suggestion/payment/email/preview/
│       │              # discord/backup/update logic
│       ├── db.ts      # Kysely + SQLite setup and migrations
│       └── app.ts     # Express app factory
├── shared/            # Code shared by client + server — pure data and maths, no I/O
│                      # rpe, vbt, videoAnalysis, exercises, knowledge, payments,
│                      # scoring, warmup, exportLayout, discord, types
├── electron/          # Electron main process
│   └── src/
│       └── main.ts    # starts Express, opens BrowserWindow, runs auto-update
├── scripts/           # release.mjs — one-command version bump, tag and push
└── package.json       # npm workspaces root (client, server, shared, electron)
```

The app runs Express on `localhost:3001` inside the Electron process. The React frontend talks to it via the `/api/*` routes. SQLite data is stored as `coachboard.sqlite` in the app's `userData` directory (`%APPDATA%\coachboard-electron` on Windows — the folder name comes from `electron/package.json` `"name"`, as no `productName` is set).

Anything that is really a calculation rather than plumbing lives in `shared/` as pure
functions with no I/O and no DOM — the RPE chart, the velocity maths, the bar-path
metrics, competition scoring. That keeps it unit-testable under a node-only test
runner even when the thing it serves (optical-flow tracking, say) can only run in a
browser. Each of those modules carries its own sourcing in its header comment, so the
reference values can be traced back to where they were published.
