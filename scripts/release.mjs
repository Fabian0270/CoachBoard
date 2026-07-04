#!/usr/bin/env node
// Cuts a release with one command:
//
//     npm run release 1.14.0
//
// Bumps the version across the root + all workspaces, syncs the lockfile,
// commits ("Bump version to 1.14.0"), pushes the branch, then creates and
// pushes the tag — which triggers .github/workflows/release.yml to build the
// Windows .exe + macOS arm64 .dmg and publish them to one GitHub Release.
//
// It refuses to run (before changing anything) if: no/invalid version, the
// working tree is dirty, you're not on main (override: RELEASE_ALLOW_BRANCH=1),
// the version is unchanged, or the tag already exists locally/on origin.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Run a command, capture and return its trimmed stdout. Throws on failure. */
const run = (cmd) => execSync(cmd, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
/** Run a command with inherited stdio so its output streams to the console. */
const runLive = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });
const fail = (msg) => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

const version = process.argv[2];
if (!version) fail('No version given.  Usage: npm run release 1.14.0');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version))
  fail(`"${version}" is not a valid version (expected e.g. 1.14.0).`);

const tag = `v${version}`;

// ── Pre-flight checks (before touching anything) ────────────────────────────
const branch = run('git rev-parse --abbrev-ref HEAD');
if (branch !== 'main' && !process.env.RELEASE_ALLOW_BRANCH)
  fail(
    `Not on main (on "${branch}"). Releases are cut from main — check out main and\n` +
      `  merge your release branch first, or set RELEASE_ALLOW_BRANCH=1 to override.`,
  );

if (run('git status --porcelain'))
  fail(
    'Working tree is not clean. Commit or stash first — the release commit should\n' +
      '  contain only the version bump.',
  );

const current = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (current === version) fail(`Already at version ${version}. Pick a new version.`);

if (run(`git tag -l ${tag}`)) fail(`Tag ${tag} already exists locally.`);
try {
  if (run(`git ls-remote --tags origin ${tag}`)) fail(`Tag ${tag} already exists on origin.`);
} catch (e) {
  if (e.code === 1 && !e.stdout && !e.stderr) {
    // ls-remote found nothing (some git builds exit 1) — that's fine.
  } else {
    fail('Could not reach origin (needed to check tags and push). Online / authenticated?');
  }
}

// ── Do it ───────────────────────────────────────────────────────────────────
console.log(`\nReleasing ${current} → ${version}  (branch: ${branch})\n`);

console.log('• Bumping versions…');
runLive(`npm pkg set version=${version}`);
runLive(`npm pkg set version=${version} --workspaces`);

console.log('• Syncing lockfile…');
runLive('npm install --package-lock-only');

console.log('• Committing…');
runLive(
  'git add package.json package-lock.json client/package.json server/package.json shared/package.json electron/package.json',
);
runLive(`git commit -m "Bump version to ${version}"`);

console.log('• Pushing branch…');
runLive('git push origin HEAD');

console.log('• Tagging + pushing tag (triggers the Release build)…');
runLive(`git tag ${tag}`);
runLive(`git push origin ${tag}`);

const repo = run('git config --get remote.origin.url')
  .replace(/\.git$/, '')
  .replace(/^git@github\.com:/, 'https://github.com/');
console.log(
  `\n✔ ${tag} pushed. Watch the build at:\n  ${repo}/actions\n` +
    `  The release will appear at:\n  ${repo}/releases/tag/${tag}\n`,
);
